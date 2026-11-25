    let db = { history: [], questions: [], flashcards: [], outlines: [], lastStudyDate: null, streak: 0, maxStreak: 0, studyLog: {} };
    let editingFcId = null; let editingOutlineId = null; let editingExamId = null; let chartInstances = {};

    window.onload = () => {
      try {
        const saved = localStorage.getItem('nomusa_db_v4');
        if (saved) { 
          const parsed = JSON.parse(saved);
          db = { ...db, ...parsed };
          if (!db.maxStreak) db.maxStreak = db.streak || 0;
          for (let date in db.studyLog) {
            if (typeof db.studyLog[date] === 'number') {
              db.studyLog[date] = { fc: db.studyLog[date], outline: 0, exam: 0 };
            }
          }
        }
        try { localStorage.removeItem('gemini_api_key'); } catch(e) {}
      } catch(e) {}
      updateStreak(); renderDashboard();
      updateConvertInputUi();
    };

    function saveDB() { 
      try { localStorage.setItem('nomusa_db_v4', JSON.stringify(db)); } catch(e) {} 
      if (window.triggerCloudSave) window.triggerCloudSave(); 
    }

    const LINES_PER_PAGE = 22; const MAX_CHARS_PER_LINE = 40; 
    let examState = { subject: '', question: '', rubric: '', time: 0, seconds: 0, totalPage: 5, currPage: 1, timer: null, answers: {}, uploadedRubricText: '' };
    let blankState = { outline: null, lines: [], answers: [], activeInput: null };
    let fcClozeState = { answers: [], activeInput: null };
    let dueCards = []; let dueOutlines = []; let currentCard = null;
    let fcHintLoading = false;
    let fcMnemonicLoading = false;
    let fcTutorLoading = false;
    let outlineAiLoading = false;
    let paragraphAiExpandLoading = false;
    let tempConvertResults = [];
    let tempConvertType = '';
    let tempConvertSubject = '';
    let convertAiLoading = false;
    let compareConceptLoading = false;
    let searchLawLoading = false;
    let analyzeHistoryLoading = false;
    let examResultAiExplainLoading = false;
    let lastExamResultRecord = null;
    let examGroundedExplainLoading = false;
    let retryGroundedRegradeLoading = false;
    /** @type {{ materials: object[], counts: object, totalChars: number, itemMetaById?: object, stats?: object } | null} */
    let lastExamGroundingPack = null;

    /** 채점 배점표 (api/grade-answer.js와 동일 기준) */
    const EXAM_RUBRIC_DIMS = [
      { key: 'issue', label: '쟁점 파악', max: 25, tip: '발문에서 핵심 쟁점을 빠짐없이 골라, 쟁점마다 판단 틀을 먼저 세운 뒤 서술했는지 점검하세요.' },
      { key: 'law', label: '법적 근거', max: 30, tip: '관련 조문·요건·효과를 답안에 구체적으로 쓰는 연습을 하세요. 단순 형식 나열은 실제 채점에서 감점되기 쉽습니다.' },
      { key: 'logic', label: '논리 전개', max: 25, tip: '사실관계→쟁점→근거→적용 순으로 한 단락이 한 흐름을 타도록 고치세요.' },
      { key: 'conclusion', label: '결론 명확성', max: 10, tip: '각 쟁점 끝에 판단/결론을 한 줄로 명시했는지, 모호한 표현은 없는지 다시 보세요.' },
      { key: 'format', label: '형식·구성', max: 10, tip: '머리말·소제목·번호 매기기 등 읽기 쉬운 구성으로 정리하면 가산되는 인상을 줍니다.' },
    ];
    const EXAM_WEAK_RATIO = 0.7;

    function getExamRoomEl() {
      return document.getElementById('exam-room');
    }

    function isExamRoomFullscreen() {
      const room = getExamRoomEl();
      return !!(room && document.fullscreenElement === room);
    }

    function syncExamFullscreenButton() {
      const btn = document.getElementById('exam-fullscreen-btn');
      if (!btn) return;
      const on = isExamRoomFullscreen();
      btn.textContent = on ? '전체화면 해제' : '전체화면';
      btn.title = on ? '전체화면 종료 (또는 ESC)' : '시험 화면만 전체화면(ESC로 종료)';
    }

    function exitFullScreen() {
      const doc = window.document;
      const exitFn =
        doc.exitFullscreen ||
        doc.mozCancelFullScreen ||
        doc.webkitExitFullscreen ||
        doc.msExitFullscreen;
      if (!exitFn || !doc.fullscreenElement) return Promise.resolve();
      return Promise.resolve(exitFn.call(doc)).catch(() => {});
    }

    async function toggleExamFullscreen() {
      const el = getExamRoomEl();
      if (!el) return;
      try {
        if (document.fullscreenElement === el) {
          await exitFullScreen();
        } else {
          const req =
            el.requestFullscreen ||
            el.webkitRequestFullscreen ||
            el.mozRequestFullScreen ||
            el.msRequestFullscreen;
          if (!req) {
            showMsg('이 브라우저에서는 전체화면을 지원하지 않습니다.');
            return;
          }
          const ret = req.call(el);
          if (ret && typeof ret.then === 'function') await ret;
        }
      } catch (e) {
        console.error('전체화면 전환 실패:', e);
        showMsg('전체화면 전환에 실패했습니다.');
      } finally {
        syncExamFullscreenButton();
      }
    }

    let examFullscreenControlsWired = false;
    function wireExamFullscreenControls() {
      if (examFullscreenControlsWired) return;
      examFullscreenControlsWired = true;
      document.getElementById('exam-fullscreen-btn')?.addEventListener('click', toggleExamFullscreen);
      const sync = () => syncExamFullscreenButton();
      document.addEventListener('fullscreenchange', sync);
      document.addEventListener('webkitfullscreenchange', sync);
      document.addEventListener('mozfullscreenchange', sync);
      document.addEventListener('MSFullscreenChange', sync);
    }

    function customConfirm(msg, onConfirm) {
      const modal = document.getElementById('confirm-modal');
      const content = document.getElementById('confirm-modal-content');
      document.getElementById('confirm-msg').innerHTML = msg.replace(/\n/g, '<br>');
      
      modal.classList.remove('hidden');
      setTimeout(() => content.classList.replace('scale-95', 'scale-100'), 10);

      const close = () => {
        content.classList.replace('scale-100', 'scale-95');
        setTimeout(() => modal.classList.add('hidden'), 150);
        document.getElementById('confirm-ok').onclick = null;
        document.getElementById('confirm-cancel').onclick = null;
      };

      document.getElementById('confirm-cancel').onclick = close;
      document.getElementById('confirm-ok').onclick = () => { close(); onConfirm(); };
    }

    function navigate(id) {
      exitFullScreen();
      
      document.querySelectorAll('.page-content').forEach(p => p.classList.remove('active'));
      const target = document.getElementById('page-' + id); if(target) target.classList.add('active');
      document.querySelectorAll('.nav-btn, .desktop-nav-btn').forEach(a => a.classList.remove('active'));
      const dBtn = document.getElementById('d-nav-' + id); const mBtn = document.getElementById('m-nav-' + id);
      if(dBtn) dBtn.classList.add('active'); if(mBtn) mBtn.classList.add('active');

      if (id === 'dashboard') renderDashboard();
      if (id === 'flashcard') renderDueFlashcards();
      if (id === 'exam') updateExamQList();
      if (id === 'convert') updateConvertInputUi();
      if (id === 'blank') { document.getElementById('blank-list-view').classList.remove('hidden'); document.getElementById('blank-quiz-view').classList.add('hidden'); renderOutlineList(); }
    }

    function showLoading(msg) { document.getElementById('loading-text').textContent = msg; document.getElementById('loading-overlay').style.display = 'flex'; }
    function hideLoading() { document.getElementById('loading-overlay').style.display = 'none'; }
    function showMsg(text) { const box = document.getElementById('message-box'); if (box) { box.textContent = text; box.style.display = 'block'; setTimeout(() => box.style.display = 'none', 3000); } }
    
    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    /**
     * AI 버튼/요청 공통: 연타 방지 · 로딩 표시 · 사용자용 에러 · 빈 응답 옵션
     * overlayLoading: true면 전역 로딩 오버레이(#loading-text)만 갱신하고 버튼은 비활성만 유지
     */
    async function runAiButtonAction({
      button = null,
      statusEl = null,
      overlayLoading = false,
      getBusy,
      setBusy,
      loadingLabel,
      execute,
      onSuccess,
      onError,
      emptyFallback = '',
      isEmptyResult = null,
    }) {
      if (getBusy()) return;

      setBusy(true);

      if (button) {
        button.disabled = true;
        if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
      }

      const renderLoading = (text) => {
        const t = text == null ? '' : String(text);
        if (overlayLoading) {
          const lt = document.getElementById('loading-text');
          if (lt) lt.textContent = t;
        } else if (statusEl) {
          statusEl.textContent = t;
        } else if (button) {
          button.textContent = t;
        }
      };

      let t0 = Date.now();
      let tick = null;

      if (overlayLoading) {
        showLoading(typeof loadingLabel === 'function' ? loadingLabel(0) : (loadingLabel || '처리 중입니다...'));
      }

      if (typeof loadingLabel === 'function') {
        if (!overlayLoading) renderLoading(loadingLabel(0));
        tick = setInterval(() => {
          renderLoading(loadingLabel((Date.now() - t0) / 1000));
        }, 500);
      } else if (loadingLabel && !overlayLoading) {
        renderLoading(loadingLabel);
      }

      try {
        const data = await execute();

        let empty =
          typeof isEmptyResult === 'function'
            ? !!isEmptyResult(data)
            : typeof data?.text === 'string' && !data.text.trim();

        if (emptyFallback && empty) {
          onError(emptyFallback);
          return;
        }

        onSuccess(data);
      } catch (e) {
        const raw = String(e?.message || '');

        const userMsg =
          /network|fetch|failed\s+to\s+fetch|load\s+failed|Load failed/i.test(raw)
            ? '네트워크 상태를 확인한 뒤 다시 시도해주세요.'
            : /^HTTP\s5\d\d/i.test(raw) || /서버 처리|서버가 잠시|Server error/i.test(raw)
              ? '서버가 잠시 응답하지 않습니다. 잠시 후 다시 시도해주세요.'
              : raw || '요청 처리에 실패했습니다. 잠시 후 다시 시도해주세요.';

        onError(userMsg);
      } finally {
        if (tick) clearInterval(tick);

        setBusy(false);

        if (overlayLoading) {
          hideLoading();
        } else if (statusEl) {
          statusEl.textContent = '';
        }

        if (button) {
          button.disabled = false;
          if (button.dataset.originalText != null) {
            button.textContent = button.dataset.originalText;
          }
        }
      }
    }

    function getLocalYYYYMMDD(d) {
        const year = d.getFullYear(); const month = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    function getToday() { return getLocalYYYYMMDD(new Date()); }
    function getYesterday() { const d = new Date(); d.setDate(d.getDate() - 1); return getLocalYYYYMMDD(d); }
    function getLocalNow() { const now = new Date(); const tzOffset = now.getTimezoneOffset() * 60000; return (new Date(now.getTime() - tzOffset)).toISOString().slice(0, 19); }
    
    function isDue(item) {
      let rev = item.nextReview || "";
      if (rev.length === 10) rev += "T00:00:00";
      if (!rev) return true;
      return rev <= getLocalNow();
    }

    function collectExamMaterialsFromDb(subject) {
      const sub = String(subject || '').trim();
      return (db.flashcards || []).filter(fc => fc && String(fc.subject || '').trim() === sub).slice(0, 16).map(fc => ({
        id: String(fc.id),
        type: 'flashcard',
        label: String(fc.front || '').slice(0, 120),
        text: `${String(fc.front || '')}\n${String(fc.back || '')}`,
      })).filter(m => m.text.trim().length > 2);
    }

    async function gradeAnswerViaServer(body, opts) {
      const options = opts || {};
      const postOnce = async (payload) => {
        const res = await fetch('/api/grade-answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        let data = null;
        try { data = await res.json(); } catch (e) {}
        if (!res.ok) {
          const msg = (data && data.message)
            ? data.message
            : res.status === 502
              ? '채점 서버가 응답하지 못했습니다(시간 초과·AI 오류 가능). 잠시 후 다시 시도하거나 루브릭·답안 길이를 줄여 보세요.'
              : `HTTP ${res.status}`;
          const err = new Error(msg);
          err.httpStatus = res.status;
          throw err;
        }
        return data;
      };

      try {
        return await postOnce(body);
      } catch (e) {
        const canLegacyFallback =
          options.allowLegacyFallback !== false &&
          body &&
          Object.prototype.hasOwnProperty.call(body, 'materials') &&
          (e.httpStatus === 502 || e.httpStatus === 503 || e.httpStatus === 504);
        if (!canLegacyFallback) throw e;
        const { materials, ...legacyBody } = body;
        void materials;
        showMsg('자료 기반 채점 서버 오류 — 모범답안 기준(무자료)으로 한 번 더 시도합니다…');
        return await postOnce(legacyBody);
      }
    }

    async function examGroundedExplainViaServer(body) {
      const res = await fetch('/api/exam-grounded-explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) {
        const msg = (data && data.message) ? data.message : `HTTP ${res.status}`;
        throw new Error(msg);
      }
      return data;
    }

    /** 모의고사 자료 매칭 — 불용어·가중키·발문·답안 동시 활용 */
    const GROUND_STOP_KO = new Set(
      `
은 는 이 가 을 를 의 에 에서 에게 로 과 와 도 만 못 및 그 또는 그리고 그러나 따라서 때문에 위하여 위한 하라 하시오 설명 논술 간략하게 간략히 다음 각각 보기 포함하여 무엇인 무엇을 해당하는 관련하여 자료 근거 있다 없다 하는
`.trim()
        .split(/\s+/)
        .filter(Boolean),
    );
    const GROUND_STOP_EN = new Set(
      ('the and or for but with from into any all not are was were been being this that these those has have had shall will may might can must about into per via').split(/\s+/),
    );

    /** 짧은 허용 2글 토큰(노무/일반 학습 명사) 일부 예외 — 추후 과목별 확장 가능 */
    const GROUND_KO_TWO_OK = new Set(['차이', '해고', '퇴직', '임금', '소송', '휴직', '정년', '수습', '기간']);

    function extractWeightedKeywords(text) {
      const map = new Map();
      const s = String(text || '').replace(/\s+/g, ' ').trim();
      if (!s) return map;

      function add(tok, weight) {
        if (!tok || tok.length < 2) return;
        const tk = /[\uac00-\ud7a3]/.test(tok) ? tok : String(tok).toLowerCase();
        if (GROUND_STOP_KO.has(tk) || GROUND_STOP_EN.has(tk)) return;
        map.set(tk, (map.get(tk) || 0) + weight);
      }

      const kor3 = [...s.matchAll(/[\uac00-\ud7a3]{3,}/g)].map((m) => m[0]);
      for (const tok of kor3) add(tok, 5);

      const kor2 = [...s.matchAll(/[\uac00-\ud7a3]{2}/g)].map((m) => m[0]);
      for (const tok of kor2) {
        if (GROUND_KO_TWO_OK.has(tok)) add(tok, 4);
      }

      let m;
      const reEnTerm = /\b[A-Z]{2,}(?:_\d)?\d*\b|[a-z][a-z0-9_-]{3,}\b/gi;
      while ((m = reEnTerm.exec(s))) add(m[0], m[0].length <= 6 && /^[a-z]/i.test(m[0]) ? 4 : 6);

      const nums = [...s.matchAll(/\b\d{2,}(?:~\d{2,})?\b/g)];
      nums.forEach((x) => add(x[0], 5));

      return map;
    }

    function groundingQuestionFlavor(question) {
      const q = String(question || '');
      if (/차이|비교|대비|구별|versus|vs\.?\s+/i.test(q)) return 'compare';
      if (/무엇|정의|의\s*미|개념|의(?:\s*의미)?|하여라/i.test(q)) return 'concept';
      if (/과정|원인|이유|절차/i.test(q)) return 'procedure';
      return 'general';
    }

    function groundingMaterialTypeBias(type, flavor) {
      const fc = type === 'flashcard' ? 8 : type === 'outline' ? 6 : type === 'saved_question' ? 7 : 5;
      if (flavor === 'concept' && type === 'flashcard') return fc + 6;
      if (flavor === 'compare') {
        if (type === 'outline' || type === 'saved_question') return fc + 7;
      }
      if (flavor === 'procedure' && type === 'outline') return fc + 6;
      return fc;
    }

    function groundingRecencyBonus(record) {
      let pts = 0;
      const rep = Number(record?.repetition ?? record?.reviews ?? 0);
      if (rep >= 9) pts += 3;
      else if (rep >= 5) pts += 2;
      else if (rep >= 2) pts += 1;
      let nr = record?.nextReview;
      if (typeof nr === 'string') {
        if (nr.length === 10) nr += 'T12:00:00';
        const t = Date.parse(nr);
        if (Number.isFinite(t)) {
          const daysAhead = (t - Date.now()) / 86400000;
          if (daysAhead <= 14 && daysAhead >= -3) pts += 2;
        }
      }
      return Math.min(pts, 8);
    }

    /** 가중키 맵 + 텍스트: 가중 매칭 점수 및 일치 목록 요약 개수용 */
    function groundingWeightedOverlap(keyMap, labelLo, corpusLo) {
      let sum = 0;
      let nLabel = 0;
      let nBody = 0;
      keyMap.forEach((w, tok) => {
        const tk = /[\uac00-\ud7a3]/.test(tok) ? tok : String(tok).toLowerCase();
        if (corpusLo.includes(tk)) {
          sum += w * (labelLo.includes(tk) ? 1.85 : 1);
          if (labelLo.includes(tk)) nLabel++;
          else nBody++;
        }
      });
      return { sum, nLabel, nBody };
    }

    /** 상위 유사 키를 자료 안에서 동시에 몇 번 맞았는지(간이) */
    function groundingCoPresenceBonus(topTokens, corpusLo) {
      if (!topTokens.length) return 0;
      let hit = 0;
      for (const tk of topTokens) {
        if (corpusLo.includes(tk)) hit++;
      }
      if (hit >= 4) return 18;
      if (hit >= 3) return 12;
      if (hit >= 2) return 7;
      return hit === 1 ? 2 : 0;
    }

    /** 제목 라벨 기본 스니펫 */
    function groundingSnipFc(frontRaw) {
      const fr = String(frontRaw || '').replace(/\s+/g, ' ').trim();
      return (fr.slice(0, 52) + (fr.length > 52 ? '…' : '')) || '(무제 카드)';
    }

    function groundingSimilarBodies(a, b) {
      const x = String(a || '')
        .slice(0, 160)
        .replace(/\s+/g, '')
        .toLowerCase();
      const y = String(b || '')
        .slice(0, 160)
        .replace(/\s+/g, '')
        .toLowerCase();
      if (!x || !y) return false;
      if (x === y) return true;
      if (Math.min(x.length, y.length) < 48) return x === y;
      let hits = 0;
      const step = 10;
      for (let i = 0; i + 18 <= Math.min(x.length, y.length); i += step) {
        const sub = x.slice(i, i + 18);
        if (sub.length >= 14 && y.includes(sub)) hits++;
      }
      return hits >= 2;
    }

    /**
     * @returns {{ materials, counts, totalChars, itemMetaById, stats }}
     */
    function gatherExamGroundingMaterials(examSubject, examQuestion, opts) {
      const o = opts || {};
      const maxItemsFinal = o.maxItems != null ? o.maxItems : 14;
      const maxTextPerItem = o.maxTextPerItem != null ? o.maxTextPerItem : 1400;
      const maxTotal = o.maxTotalChars != null ? o.maxTotalChars : 36000;
      const MIN_SCORE = o.minGroundScore != null ? o.minGroundScore : 16;
      const userAnswerRaw = typeof o.userAnswer === 'string' ? o.userAnswer : '';
      const debugLog = !!o.debugGroundingLog;

      const perTypeLimit = {
        flashcard: o.perTypeFc != null ? o.perTypeFc : 6,
        outline: o.perTypeOl != null ? o.perTypeOl : 4,
        saved_question: o.perTypeSq != null ? o.perTypeSq : 4,
      };

      const qMap = extractWeightedKeywords(examQuestion);
      const aMap = extractWeightedKeywords(userAnswerRaw);
      const flavor = groundingQuestionFlavor(examQuestion);

      const topQs = [...qMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map((x) => (/[\uac00-\ud7a3]/.test(x[0]) ? x[0] : String(x[0]).toLowerCase()));

      const subjNorm = String(examSubject || '').trim();
      function trimBody(str) {
        return String(str || '').replace(/\s+/g, ' ').trim();
      }
      function sameSubject(matSubj) {
        return !!(subjNorm && String(matSubj || '').trim() === subjNorm);
      }
      function otherSubject(matSubj) {
        const t = String(matSubj || '').trim();
        return !!(subjNorm && t && t !== subjNorm);
      }

      const candidates = [];

      function pushCand(entry) {
        const labelLo = String(entry.mat.label || '').toLowerCase().replace(/\s+/g, ' ');
        const textLo = String(entry.mat.text || '').toLowerCase().replace(/\s+/g, ' ');
        let score = groundingMaterialTypeBias(entry.mat.type, flavor);
        const reasons = [];

        if (sameSubject(entry.sourceSubject)) {
          score += 20;
          reasons.push('동일 과목');
        } else if (otherSubject(entry.sourceSubject)) {
          score -= 10;
        }

        score += groundingRecencyBonus(entry.raw || {});

        const qOv = groundingWeightedOverlap(qMap, labelLo, textLo);
        score += qOv.sum * 0.72;
        if (qOv.nLabel >= 3) reasons.push(`발문·제목 근접(${qOv.nLabel})`);
        else if (qOv.nLabel >= 1) reasons.push(`발문 키(${qOv.nLabel + qOv.nBody}곳)`);

        const aOv = groundingWeightedOverlap(aMap, labelLo, textLo);
        if (aOv.sum > 0) {
          score += aOv.sum * 0.45;
          reasons.push(`답안 키워드 교차`);
        }

        score += groundingCoPresenceBonus(topQs, textLo);
        const coCount = topQs.filter((t) => textLo.includes(t)).length;
        if (coCount >= 2) reasons.push(`핵심어 동시 ${coCount}개`);

        if (entry.mat.type === 'saved_question') score += 4;

        if (score >= MIN_SCORE && reasons.length > 6) reasons.length = 6;
        entry.matchScore = Math.round(score * 100) / 100;

        entry.reasons = reasons.length ? [...new Set(reasons)].slice(0, 6) : [];
        if (
          entry.matchScore >= MIN_SCORE &&
          entry.reasons.length === 0 &&
          sameSubject(entry.sourceSubject)
        ) {
          entry.reasons.push(flavor !== 'general' ? `문항 패턴 우대 (${flavor})` : '과목 우선 포함');
        }
        entry.reasons = entry.reasons.slice(0, 4);

        candidates.push(entry);
      }

      (db.flashcards || []).forEach((c) => {
        const text = `${String(c.front || '')}\n${String(c.back || '')}`;
        const mat = {
          id: `fc:${c.id}`,
          type: 'flashcard',
          label: groundingSnipFc(c.front),
          text,
        };
        pushCand({ mat, raw: c, sourceSubject: c.subject });
      });

      (db.outlines || []).forEach((ol) => {
        const text = `${String(ol.title || '')}\n${String(ol.content || '')}`;
        const mat = {
          id: `ol:${ol.id}`,
          type: 'outline',
          label: String(ol.title || '').slice(0, 92) || '(무제 목차)',
          text,
        };
        pushCand({ mat, raw: ol, sourceSubject: ol.subject });
      });

      (db.questions || []).forEach((q) => {
        const text = `${String(q.question || '')}\n[Rubric]\n${String(q.rubric || '')}`;
        const mq = trimBody(q.question || '');
        const mat = {
          id: `sq:${q.id}`,
          type: 'saved_question',
          label: `[저장 문제] ${mq.slice(0, 40)}${mq.length > 40 ? '…' : ''}`,
          text,
        };
        pushCand({ mat, raw: q, sourceSubject: q.subject });
      });

      const stats = {
        candidateCount: candidates.length,
        minScoreUsed: MIN_SCORE,
        flavor,
        topQuestionTokens: topQs.slice(0, 6),
      };

      const survived = candidates.filter((c) => c.matchScore >= MIN_SCORE);
      stats.survivedMinScore = survived.length;

      survived.sort((a, b) => b.matchScore - a.matchScore);

      let pool = survived;
      if (pool.length === 0 && candidates.length) {
        const floor = Math.max(4, MIN_SCORE - 10);
        pool = candidates
          .filter((c) => c.matchScore >= floor)
          .sort((a, b) => b.matchScore - a.matchScore);
        stats.usedSoftFloor = true;
        stats.softFloor = floor;
      }

      function selectFromSortedRows(rows) {
        const sel = [];
        const typeCnt = { flashcard: 0, outline: 0, saved_question: 0 };
        let tc = 0;
        outer: for (const row of rows) {
          const t = row.mat.type;
          if (typeCnt[t] >= (perTypeLimit[t] ?? 99)) continue;

          let body = trimBody(row.mat.text);
          if (!body) continue;
          const slice = body.slice(0, maxTextPerItem);
          if (tc + slice.length > maxTotal) {
            if (sel.length >= 6) break;
            continue;
          }

          const dupNear =
            sel.find((p) => p.label === row.mat.label && p.type === row.mat.type) ||
            sel.find((p) => groundingSimilarBodies(p.textSlice, slice));
          if (dupNear) continue;

          sel.push({
            mat: row.mat,
            matchScore: row.matchScore,
            reasons: row.reasons,
            textSlice: slice,
            type: t,
            label: row.mat.label,
          });
          typeCnt[t]++;
          tc += slice.length;
          if (sel.length >= maxItemsFinal) break outer;
        }
        return { sel, typeCnt, totalCharsLocal: tc };
      }

      const firstPick = selectFromSortedRows(pool);
      let pickedRows = firstPick.sel;
      let totalChars = firstPick.totalCharsLocal;

      if (!pickedRows.length && candidates.length) {
        const laxPool = [...candidates].sort((a, b) => b.matchScore - a.matchScore).slice(0, 48);
        const r2 = selectFromSortedRows(laxPool);
        if (r2.sel.length) {
          pickedRows = r2.sel;
          totalChars = r2.totalCharsLocal;
          stats.fallbackRelaxedDedup = true;
        }
      }

      const picked = pickedRows;

      const materials = [];
      const itemMetaById = {};
      picked.forEach((p) => {
        materials.push({
          id: p.mat.id,
          type: p.mat.type,
          label: p.mat.label,
          text: p.textSlice,
        });
        itemMetaById[p.mat.id] = { score: p.matchScore, reasons: p.reasons };
      });

      stats.finalCount = materials.length;
      stats.avgTopScore =
        picked.length > 0
          ? Math.round((picked.reduce((s, x) => s + x.matchScore, 0) / picked.length) * 10) / 10
          : 0;

      if (debugLog && typeof console !== 'undefined' && console.groupCollapsed) {
        console.groupCollapsed('[grounding] pack');
        console.log('stats', stats);
        console.table(
          materials.map((m) => ({
            id: m.id,
            score: itemMetaById[m.id]?.score,
            reasons: (itemMetaById[m.id]?.reasons || []).join(' · '),
          })),
        );
        console.groupEnd();
      }

      const counts = { flashcard: 0, outline: 0, saved_question: 0 };
      materials.forEach((m) => {
        if (counts[m.type] !== undefined) counts[m.type]++;
      });

      return { materials, counts, totalChars, itemMetaById, stats };
    }

    function materialTypeLabelKo(type) {
      if (type === 'flashcard') return '플래시카드';
      if (type === 'outline') return '개요';
      if (type === 'saved_question') return '저장 문제';
      return type;
    }

    function updateExamGroundingPanelFromPack() {
      const pack = lastExamGroundingPack;
      const summaryEl = document.getElementById('res-grounding-summary-line');
      const listEl = document.getElementById('res-grounding-id-list');
      if (!summaryEl || !listEl || !pack) return;
      const n = pack.materials.length;
      const c = pack.counts;
      if (n === 0) {
        summaryEl.innerHTML =
          '<span class="text-rose-600 font-bold">연결 가능한 학습 자료가 없습니다.</span> 같은 <strong>과목</strong>의 플래시카드·개요 또는 발문과 단어가 겹치는 자료를 쌓아 주세요.';
        listEl.innerHTML = '';
        return;
      }
      const st = pack.stats || {};
      const avgTxt =
        typeof st.avgTopScore === 'number' && st.avgTopScore > 0
          ? ` · 선별 문서 평균 점수 <strong>${st.avgTopScore}</strong>`
          : '';
      const candTxt =
        typeof st.candidateCount === 'number'
          ? ` <span class="text-slate-400 font-normal">(후보 ${st.candidateCount}→통과 ${st.survivedMinScore ?? '-'})</span>`
          : '';
      summaryEl.innerHTML =
        `선택 근거 자료 <strong>${n}</strong>건 (플래시카드 <strong>${c.flashcard}</strong> · 개요 <strong>${c.outline}</strong> · 저장문제 <strong>${c.saved_question}</strong>), 발췌 약 <strong>${pack.totalChars}</strong>자${avgTxt}${candTxt}`;
      const ib = pack.itemMetaById || {};
      listEl.innerHTML = pack.materials
        .map((m) => {
          const t = escapeHtml(materialTypeLabelKo(m.type));
          const lbl = escapeHtml(m.label || m.id);
          const meta = ib[m.id];
          const sr = meta && meta.score != null ? ` <span class="text-slate-400">[${meta.score}]</span>` : '';
          const rs =
            meta && meta.reasons && meta.reasons.length
              ? ` <span class="text-slate-500">${escapeHtml(meta.reasons.slice(0, 2).join(' · '))}</span>`
              : '';
          return `<li class="leading-snug"><span class="text-teal-700 font-bold">${t}</span>${sr} — ${lbl}${rs}</li>`;
        })
        .join('');
    }

    async function runGroundedExamExplain() {
      if (!lastExamResultRecord || !lastExamGroundingPack) {
        showMsg('결과를 먼저 불러오거나 제출해 주세요.');
        return;
      }
      if (!lastExamGroundingPack.materials.length) {
        showMsg('분석할 저장 자료가 없습니다. 과목별 플래시카드·개요나 저장 문제를 추가한 뒤 다시 시도해 주세요.');
        return;
      }
      const r = lastExamResultRecord;
      const btn = document.getElementById('res-grounded-explain-btn');
      const panel = document.getElementById('res-grounded-explain-panel');
      panel.classList.add('hidden');
      panel.innerHTML = '';

      await runAiButtonAction({
        button: btn,
        getBusy: () => examGroundedExplainLoading,
        setBusy: (v) => {
          examGroundedExplainLoading = v;
        },
        loadingLabel: (sec) =>
          sec < 8 ? '저장 자료만 바탕으로 해설 작성 중…' : sec < 18 ? '인용 검증 포함, 조금 더 걸립니다…' : '응답 대기 중…',
        execute: async () =>
          examGroundedExplainViaServer({
            subject: String(r.subject || ''),
            question: String(r.question || ''),
            userAnswer: String(r.fullAnswer || ''),
            rubricExcerpt: String(r.rubric || '').slice(0, 12000),
            materials: lastExamGroundingPack.materials,
          }),
        isEmptyResult: () => false,
        emptyFallback: '응답을 해석하지 못했습니다. 잠시 후 다시 시도해 주세요.',
        onSuccess: (data) => {
          const pack = lastExamGroundingPack;
          const insufficient = !!(data && data.insufficientData);
          const citations = Array.isArray(data.citations) ? data.citations : [];
          let html = '';

          html += insufficient
            ? '<span class="inline-block px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-amber-100 text-amber-800 mb-3">근거 검증 결과: 자료 부족 또는 인용 불가</span>'
            : '<span class="inline-block px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-teal-100 text-teal-800 mb-3">근거 검증 결과: 제공 자료에서 인용 확보</span>';

          if (data.insufficientReason) {
            html += `<div class="p-3 mb-3 rounded-lg bg-amber-50 border border-amber-100 text-[11px] text-amber-900 whitespace-pre-wrap">${escapeHtml(data.insufficientReason)}</div>`;
          }
          if (data.verdict) {
            html += `<p class="font-bold text-slate-900 mb-1">판정 (자료 기준)</p><div class="mb-3 whitespace-pre-wrap">${escapeHtml(data.verdict).replace(/\n/g, '<br>')}</div>`;
          }
          if (data.explanation) {
            html += `<p class="font-bold text-slate-900 mb-1">해설 본문</p><div class="mb-3 whitespace-pre-wrap">${escapeHtml(data.explanation).replace(/\n/g, '<br>')}</div>`;
          }

          html += `<p class="font-bold text-slate-900 mb-2 mt-4 border-t border-slate-100 pt-3"><i class="ri-double-quotes-l"></i> 근거 인용 (복붙 검증 통과 분만 표시)</p>`;
          if (citations.length === 0) {
            html += `<p class="text-slate-500 text-[11px] mb-2">표시 가능한 인용이 없습니다. 자료 안에 해당 문구가 문자 그대로 있어야 합니다.</p>`;
          } else {
            html += '<ul class="space-y-3">';
            citations.forEach((cit) => {
              const meta = pack.materials.find((x) => x.id === cit.materialId);
              const typeKo = escapeHtml(materialTypeLabelKo(meta ? meta.type : ''));
              const lbl = escapeHtml((meta && meta.label) || cit.materialId);
              html +=
                `<li class="border border-slate-200 rounded-xl p-3 bg-slate-50/80">` +
                `<div class="text-[10px] font-extrabold text-teal-700 mb-1">${typeKo}<span class="text-slate-400 font-normal"> · </span>${lbl}</div>` +
                `<blockquote class="text-[11px] border-l-4 border-teal-400 pl-2 my-2 text-slate-800 italic">${escapeHtml(cit.quote || '')}</blockquote>` +
                `<p class="text-[11px] text-slate-600"><span class="font-bold text-slate-700">연결:</span> ${escapeHtml(cit.relevance || '')}</p>` +
                `</li>`;
            });
            html += '</ul>';
          }

          panel.classList.remove('hidden');
          panel.innerHTML = html;
        },
        onError: (msg) => {
          panel.classList.remove('hidden');
          panel.innerHTML = `<p class="text-rose-600 font-bold">${escapeHtml(msg)}</p>`;
        },
      });
    }

    async function getFcHintViaServer({ subject, front, back }) {
      const res = await fetch('/api/fc-hint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, front, back }),
      });
      let data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) {
        const msg = (data && data.message) ? data.message : `HTTP ${res.status}`;
        throw new Error(msg);
      }
      return data;
    }

    async function getFcMnemonicViaServer({ subject, front, back }) {
      const res = await fetch('/api/fc-mnemonic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, front, back }),
      });
      let data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) {
        const msg = (data && data.message) ? data.message : `HTTP ${res.status}`;
        throw new Error(msg);
      }
      return data;
    }

    async function askAiTutorViaServer({ subject, front, back, question }) {
      const res = await fetch('/api/ai-tutor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, front, back, question }),
      });
      let data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) {
        const msg = (data && data.message) ? data.message : `HTTP ${res.status}`;
        throw new Error(msg);
      }
      return data;
    }

    async function compareConceptsViaServer({ conceptA, conceptB }) {
      const res = await fetch('/api/compare-concepts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conceptA, conceptB }),
      });
      let data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) {
        const msg = (data && data.message) ? data.message : `HTTP ${res.status}`;
        throw new Error(msg);
      }
      return data;
    }

    async function searchLawViaServer({ query }) {
      const res = await fetch('/api/search-law', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      let data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) {
        const msg = (data && data.message) ? data.message : `HTTP ${res.status}`;
        throw new Error(msg);
      }
      return data;
    }

    async function analyzeStudyHistoryViaServer({ historyText }) {
      const res = await fetch('/api/analyze-study-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ historyText }),
      });
      let data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) {
        const msg = (data && data.message) ? data.message : `HTTP ${res.status}`;
        throw new Error(msg);
      }
      return data;
    }

    async function generateOutlineViaServer({ subject, title }) {
      const res = await fetch('/api/generate-outline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, title }),
      });
      let data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) {
        const msg = (data && data.message) ? data.message : `HTTP ${res.status}`;
        throw new Error(msg);
      }
      return data;
    }

    async function generateParagraphViaServer({ subject, title, outline }) {
      const res = await fetch('/api/generate-paragraph', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, title, outline }),
      });
      let data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) {
        const msg = (data && data.message) ? data.message : `HTTP ${res.status}`;
        throw new Error(msg);
      }
      return data;
    }

    async function processAiConvertViaServer({ subject, mode, sourceText, images }) {
      const res = await fetch('/api/process-ai-convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, mode, sourceText, images }),
      });
      let data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) {
        const msg = (data && data.message) ? data.message : `HTTP ${res.status}`;
        throw new Error(msg);
      }
      return data;
    }

    function updateStreak() {
      const today = getToday();
      const yesterday = getYesterday();
      if (db.lastStudyDate === today || db.lastStudyDate === yesterday) { /* 유지 */ } 
      else if (db.lastStudyDate !== null) db.streak = 0;
      
      if (db.streak > (db.maxStreak || 0)) db.maxStreak = db.streak;
      saveDB();
    }

    function markStudiedToday(type = 'fc') {
      const today = getToday();
      if (db.lastStudyDate !== today) {
        const yesterday = getYesterday();
        if (db.lastStudyDate === yesterday) db.streak++; else db.streak = 1;
        db.lastStudyDate = today; 
      }
      
      if (db.streak > (db.maxStreak || 0)) db.maxStreak = db.streak;

      db.studyLog = db.studyLog || {};
      if(typeof db.studyLog[today] === 'number') { db.studyLog[today] = { fc: db.studyLog[today], outline: 0, exam: 0 }; }
      if(!db.studyLog[today]) { db.studyLog[today] = { fc: 0, outline: 0, exam: 0 }; }
      db.studyLog[today][type] = (db.studyLog[today][type] || 0) + 1;
      saveDB();
      if(document.getElementById('page-dashboard').classList.contains('active')) renderDashboard();
    }

    function getExamDate() {
      if (!db.examDate) return null;
      const d = new Date(db.examDate + 'T00:00:00');
      return isNaN(d.getTime()) ? null : d;
    }

    function editExamDate() {
      const cur = db.examDate || '';
      const input = window.prompt('시험일을 YYYY-MM-DD 형식으로 입력하세요.\n비워 두면 \'미정\'으로 표시됩니다.', cur);
      if (input === null) return;
      const trimmed = input.trim();
      if (!trimmed) { delete db.examDate; saveDB(); renderDashboard(); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed) || isNaN(new Date(trimmed + 'T00:00:00').getTime())) {
        alert('날짜 형식이 올바르지 않습니다. 예: 2027-08-28');
        return;
      }
      db.examDate = trimmed;
      saveDB();
      renderDashboard();
    }

    function renderDashboard() {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const target = getExamDate();
      const dDayEl = document.getElementById('d-day-val');
      if (!target) {
        dDayEl.textContent = '미정';
        dDayEl.classList.remove('text-emerald-500', 'text-slate-400');
        dDayEl.classList.add('text-slate-400');
      } else {
        const diff = Math.round((target - today) / 86400000);
        dDayEl.textContent = diff >= 0 ? `D-${diff}` : `D+${-diff}`;
        dDayEl.classList.remove('text-emerald-500', 'text-slate-400');
        dDayEl.classList.add(diff >= 0 ? 'text-emerald-500' : 'text-slate-400');
      }
      
      document.getElementById('streak-val').textContent = db.streak || 0;
      document.getElementById('max-streak-val').textContent = db.maxStreak || db.streak || 0;
      
      dueCards = db.flashcards.filter(isDue);
      dueOutlines = db.outlines.filter(isDue);
      document.getElementById('due-fc-val').textContent = dueCards.length;
      document.getElementById('due-outline-val').textContent = dueOutlines.length;
      document.getElementById('total-exams-val').textContent = db.history.length;
      
      renderHistoryTable();

      if (typeof Chart !== 'undefined') drawDashboardCharts();
    }

    function renderHistoryTable() {
      const tbody = document.getElementById('history-tbody');
      const filterEl = document.getElementById('history-filter-subject');
      const filter = filterEl ? filterEl.value : 'all';

      let filteredHistory = db.history || [];
      if (filter !== 'all') {
          filteredHistory = filteredHistory.filter(h => h.subject === filter);
      }

      if (filteredHistory.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" class="py-10 text-center text-gray-400">기록이 없습니다.</td></tr>';
      } else {
          tbody.innerHTML = filteredHistory.slice(-5).reverse().map(h => `
              <tr class="border-b border-gray-50 hover:bg-gray-50 group">
                  <td class="py-3 px-2 text-[12px] text-gray-500 text-center">${h.date}</td>
                  <td class="py-3 px-2 font-bold text-slate-700 text-[13px] text-center">${h.subject}</td>
                  <td class="py-3 px-2 text-emerald-600 font-extrabold text-center">${h.score !== null && h.score !== undefined && h.score !== '' ? `${h.score}점` : '미확정'}</td>
                  <td class="py-3 px-2 text-center whitespace-nowrap">
                      <button onclick="viewHistory(${h.id})" class="px-3 py-1 bg-emerald-50 text-emerald-600 text-[10px] font-bold rounded hover:bg-emerald-500 hover:text-white transition-all shadow-sm">결과</button>
                      <button onclick="retryExam(${h.id})" class="px-3 py-1 bg-blue-50 text-blue-600 text-[10px] font-bold rounded hover:bg-blue-500 hover:text-white transition-all shadow-sm ml-1"><i class="ri-refresh-line"></i> 재도전</button>
                  </td>
              </tr>
          `).join('');
      }
    }

    function retryExam(id) {
      const record = db.history.find(h => String(h.id) === String(id));
      if(!record) return;
      
      document.getElementById('exam-subject').value = record.subject;
      document.getElementById('exam-direct-q').value = record.question || '문제 내용을 불러올 수 없습니다.';
      
      document.querySelector('input[name="rubric-mode"][value="text"]').click();
      toggleRubricMode();
      
      let prevRubric = record.rubric || '';
      prevRubric = prevRubric.replace(/\[강사 채점평 및 주의사항.*?\]\n/g, '').replace(/\[기본 모범답안 및 배점\]\n/g, '').trim();
      document.getElementById('exam-rubric-text').value = prevRubric;
      
      navigate('exam');
      showMsg("과거 모의고사 세팅이 완료되었습니다. 타이머를 확인하고 시작하세요!");
    }

    function drawDashboardCharts() {
      const ctxWeekly = document.getElementById('chart-weekly');
      if(ctxWeekly) {
        const last7Days = Array.from({length: 7}, (_, i) => {
            const d = new Date(); d.setDate(d.getDate() - (6 - i));
            return getLocalYYYYMMDD(d);
        });
        const weeklyDataFc = last7Days.map(date => {
            if(!db.studyLog || !db.studyLog[date]) return 0;
            if(typeof db.studyLog[date] === 'number') return db.studyLog[date];
            return db.studyLog[date].fc || 0;
        });
        const weeklyDataOutline = last7Days.map(date => {
            if(!db.studyLog || !db.studyLog[date]) return 0;
            if(typeof db.studyLog[date] === 'number') return 0;
            return db.studyLog[date].outline || 0;
        });
        const labels = last7Days.map(date => date.slice(5).replace('-','/'));
        const maxOutline = Math.max(...weeklyDataOutline, 0);
        const outlineAxisMax = Math.max(5, Math.ceil(maxOutline * 1.2 / 5) * 5);

        if(chartInstances['weekly']) chartInstances['weekly'].destroy();
        chartInstances['weekly'] = new Chart(ctxWeekly, {
            data: {
                labels: labels,
                datasets: [
                    { type: 'line', label: '목차 (회)', data: weeklyDataOutline, yAxisID: 'y1', borderColor: '#f59e0b', backgroundColor: '#f59e0b', borderWidth: 2, tension: 0.3, fill: false, pointBackgroundColor: '#f59e0b', order: 1 },
                    { type: 'bar', label: '카드 (장)', data: weeklyDataFc, yAxisID: 'y', backgroundColor: 'rgba(16, 185, 129, 0.8)', borderRadius: 4, order: 2 }
                ]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                legend: {
                  display: true,
                  position: 'top',
                  labels: { boxWidth: 10, font: { size: 10, family: 'Pretendard' } },
                },
              },
              scales: {
                y: {
                  position: 'left',
                  beginAtZero: true,
                  ticks: { precision: 0 },
                  suggestedMax: 120,
                },
                y1: {
                  position: 'right',
                  beginAtZero: true,
                  max: outlineAxisMax,
                  ticks: { precision: 0, stepSize: Math.max(1, Math.ceil(outlineAxisMax / 5)) },
                  grid: { drawOnChartArea: false },
                },
              },
            },
        });
      }

      const ctxSub = document.getElementById('chart-subjects');
      if(ctxSub) {
        const subCounts = {};
        db.history.forEach(h => { subCounts[h.subject] = (subCounts[h.subject] || 0) + 1; });
        const subLabels = Object.keys(subCounts);
        const subData = Object.values(subCounts);
        
        if(chartInstances['subjects']) chartInstances['subjects'].destroy();
        chartInstances['subjects'] = new Chart(ctxSub, {
            type: 'doughnut',
            data: { labels: subLabels.length ? subLabels : ['기록 없음'], datasets: [{ data: subData.length ? subData : [1], backgroundColor: subData.length ? ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b'] : ['#e2e8f0'], borderWidth: 0 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { boxWidth: 10, font: { size: 10, family: 'Pretendard' } } } }, cutout: '70%' }
        });
      }

      const ctxScore = document.getElementById('chart-scores');
      if(ctxScore) {
        const sortedHistory = [...db.history].sort((a,b) => a.id - b.id);
        const scoreLabels = sortedHistory.map((h, i) => `${i+1}회차`);
        const scoreData = sortedHistory.map(h => {
          const n = Number(h.score);
          return Number.isFinite(n) ? n : null;
        });

        if(chartInstances['scores']) chartInstances['scores'].destroy();
        chartInstances['scores'] = new Chart(ctxScore, {
            type: 'line',
            data: { labels: scoreLabels.length ? scoreLabels : ['-'], datasets: [{ label: '모의고사 점수', data: scoreData.length ? scoreData : [null], spanGaps: true, borderColor: '#f43f5e', backgroundColor: 'rgba(244, 63, 94, 0.1)', borderWidth: 2, pointBackgroundColor: '#f43f5e', fill: true, tension: 0.3 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100 } } }
        });
      }
    }

    function viewHistory(id) { const record = db.history.find(h => String(h.id) === String(id)); if(record) { renderExamResult(record); navigate('result'); } }

    async function analyzeStudyHistory() {
      if (analyzeHistoryLoading) return;
      if (db.history.length === 0) { showMsg("기록이 없습니다."); return; }

      const lines = db.history.slice(-5).map(h => {
        const missing = (h.feedback && typeof h.feedback.missing === 'string') ? h.feedback.missing : '';
        const sc = (h.score !== null && h.score !== undefined && h.score !== '') ? `${h.score}점` : '미확정';
        return `[${h.subject}] ${sc} - ${missing}`;
      });
      const historyText = lines.join('\n').trim();
      if (!historyText) { showMsg("분석할 기록 정보가 부족합니다."); return; }
      if (historyText.length > 5000) { showMsg("기록 요약 길이가 너무 깁니다."); return; }

      analyzeHistoryLoading = true;
      showLoading("취약점 스캔 중...");
      try {
        const data = await analyzeStudyHistoryViaServer({ historyText });
        const box = document.getElementById('ai-analysis-box');
        const content = document.getElementById('ai-analysis-content');
        if (box && content) {
          box.classList.remove('hidden');
          content.textContent = data.analysis ?? '';
        }
      } catch (e) { showMsg(e.message); } finally { hideLoading(); analyzeHistoryLoading = false; }
    }

    async function searchLawDB() {
      if (searchLawLoading) return;
      const query = document.getElementById('law-search-input').value.trim();
      if (!query) { showMsg('검색어를 입력해주세요.'); return; }
      if (query.length > 300) { showMsg('검색어는 300자 이내로 입력해주세요.'); return; }

      searchLawLoading = true;
      const resEl = document.getElementById('law-search-result');
      resEl.classList.remove('hidden');
      resEl.style.display = '';
      resEl.textContent = '🔍 검색 중...';

      try {
        const data = await searchLawViaServer({ query });
        resEl.textContent = data.answer ?? '';
      } catch (e) {
        resEl.textContent = e.message || '검색 중 오류가 발생했습니다.';
      } finally {
        searchLawLoading = false;
      }
    }

    async function compareConceptsWithAI() {
      if (compareConceptLoading) return;
      const a = document.getElementById('compare-a').value.trim();
      const b = document.getElementById('compare-b').value.trim();
      if (!a || !b) { showMsg("비교할 두 개념을 모두 입력해주세요."); return; }
      if (a.length > 200 || b.length > 200) { showMsg("입력 길이가 너무 깁니다. (각 200자 이내)"); return; }

      compareConceptLoading = true;
      const resEl = document.getElementById('compare-result');
      resEl.classList.remove('hidden');
      resEl.innerHTML = '<div class="text-center text-indigo-400 font-bold animate-pulse text-xs py-4">✨ AI가 두 개념을 치밀하게 분석하고 있습니다...</div>';

      try {
        const res = await compareConceptsViaServer({ conceptA: a, conceptB: b });
        const body = escapeHtml(res.comparison).replace(/\n/g, '<br>');
        resEl.innerHTML = `<div class="text-sm text-slate-700 leading-relaxed break-keep">${body}</div>`;
      } catch(e) {
        resEl.innerHTML = `<span class="text-red-500">오류 발생: ${escapeHtml(e.message)}</span>`;
      } finally {
        compareConceptLoading = false;
      }
    }

    function getConvertInputMode() {
      return document.querySelector('input[name="input-mode"]:checked')?.value || 'pdf';
    }

    function updateConvertInputUi() {
      const mode = getConvertInputMode();
      const btn = document.getElementById('convert-start-btn');
      const hint = document.getElementById('convert-mode-hint');
      if (mode === 'pdf') {
        if (btn) btn.innerHTML = '<i class="ri-magic-line"></i> PDF AI 추출 시작';
        if (hint) hint.textContent = 'PDF에서 문제·모범답안을 AI가 추출합니다. 스캔 PDF는 텍스트 추출이 어려울 수 있습니다.';
      } else {
        if (btn) btn.innerHTML = '<i class="ri-text-wrap"></i> 텍스트 바로 변환';
        if (hint) hint.textContent = '붙여넣은 텍스트를 AI 없이 바로 정리합니다. 미리보기에서 수정한 뒤 저장하세요.';
      }
    }

    function toggleInputMode() {
      const mode = getConvertInputMode();
      if (mode === 'pdf') {
        document.getElementById('pdf-upload-area').classList.remove('hidden');
        document.getElementById('text-input-area').classList.add('hidden');
      } else {
        document.getElementById('pdf-upload-area').classList.add('hidden');
        document.getElementById('text-input-area').classList.remove('hidden');
      }
      updateConvertInputUi();
    }

    function parseExamTextFromPaste(rawText, subject) {
      const text = String(rawText || '').replace(/\r\n/g, '\n').trim();
      if (!text) return [];

      const rubricHeader =
        /^\s*[\[【]?(?:모범답안(?:\s*및\s*배점)?|채점\s*기준(?:\s*및\s*모범답안)?|기본\s*모범답안|강사\s*채점평(?:\s*및\s*주의사항)?|rubric)[\]】]?\s*[:：]?\s*$/im;
      const rubricSplit = text.split(rubricHeader);
      if (rubricSplit.length >= 2) {
        const question = rubricSplit[0]
          .replace(/^\s*[\[【]?문제[\]】]?\s*[:：]?\s*\n?/i, '')
          .trim();
        const rubric = rubricSplit.slice(1).join('\n\n').trim();
        if (question) {
          return [{
            subject,
            question: question.slice(0, 8000),
            rubric: rubric.slice(0, 15000),
          }];
        }
      }

      const inline = text.match(
        /^\s*문제\s*[:：]?\s*\n([\s\S]*?)\n\s*모범답(?:안)?(?:\s*및\s*배점)?\s*[:：]?\s*\n([\s\S]*)$/im,
      );
      if (inline) {
        return [{
          subject,
          question: inline[1].trim().slice(0, 8000),
          rubric: inline[2].trim().slice(0, 15000),
        }];
      }

      const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
      if (blocks.length >= 2) {
        return [{
          subject,
          question: blocks[0].slice(0, 8000),
          rubric: blocks.slice(1).join('\n\n').slice(0, 15000),
        }];
      }

      return [{ subject, question: text.slice(0, 8000), rubric: '' }];
    }

    function parseFlashcardTextFromPaste(rawText) {
      const text = String(rawText || '').replace(/\r\n/g, '\n').trim();
      if (!text) return [];

      const cards = [];
      const chunks = text.split(/\n-{3,}\n|\n(?:={3,}|#{3,})\n/).map((s) => s.trim()).filter(Boolean);

      for (const chunk of chunks) {
        const labeled = chunk.match(
          /^(?:앞|front|질문|Q)\s*[:：]\s*([\s\S]*?)\n(?:뒤|back|답|A)\s*[:：]\s*([\s\S]*)$/im,
        );
        if (labeled) {
          cards.push({ front: labeled[1].trim(), back: labeled[2].trim() });
          continue;
        }
        if (!chunk.includes('\n') && /[\t|]/.test(chunk)) {
          const sep = chunk.includes('\t') ? '\t' : '|';
          const parts = chunk.split(sep).map((p) => p.trim()).filter(Boolean);
          if (parts.length >= 2) {
            cards.push({ front: parts[0], back: parts.slice(1).join(sep) });
            continue;
          }
        }
        const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length >= 2) {
          cards.push({ front: lines[0], back: lines.slice(1).join('\n') });
        }
      }

      if (cards.length) {
        return cards
          .filter((c) => c.front && c.back)
          .slice(0, 20)
          .map((c) => ({
            front: c.front.slice(0, 600),
            back: c.back.slice(0, 3500),
          }));
      }

      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      for (let i = 0; i + 1 < lines.length; i += 2) {
        if (/^(?:앞|front|질문|Q)\s*[:：]/i.test(lines[i])) continue;
        cards.push({ front: lines[i], back: lines[i + 1] });
      }
      if (cards.length) {
        return cards
          .filter((c) => c.front && c.back)
          .slice(0, 20)
          .map((c) => ({
            front: c.front.slice(0, 600),
            back: c.back.slice(0, 3500),
          }));
      }

      if (lines.length >= 1) {
        return [{
          front: lines[0].slice(0, 600),
          back: (lines.slice(1).join('\n') || lines[0]).slice(0, 3500),
        }];
      }
      return [];
    }

    function parsePastedTextForConvert(rawText, mode, subject) {
      return mode === 'exam'
        ? parseExamTextFromPaste(rawText, subject)
        : parseFlashcardTextFromPaste(rawText);
    }

    function processTextDirectConvert() {
      if (convertAiLoading) return;

      const textQ = document.getElementById('text-q').value.trim();
      if (!textQ) {
        showMsg('변환할 텍스트를 입력해주세요.');
        return;
      }

      tempConvertType = document.getElementById('convert-type').value;
      tempConvertSubject = document.getElementById('convert-subject').value;
      const subject = String(tempConvertSubject || '').trim();
      if (!subject) {
        showMsg('과목을 선택해주세요.');
        return;
      }

      convertAiLoading = true;
      try {
        tempConvertResults = parsePastedTextForConvert(textQ, tempConvertType, subject);
        if (!tempConvertResults.length) {
          showMsg('텍스트에서 변환할 항목을 찾지 못했습니다. 형식 안내를 참고해 주세요.');
          return;
        }
        renderConvertPreview();
        showMsg(`✅ ${tempConvertResults.length}개 항목을 정리했습니다. 미리보기를 확인해 주세요.`);
      } finally {
        convertAiLoading = false;
      }
    }

    async function processPdfAiConvert() {
      if (convertAiLoading) return;

      const fileQ = document.getElementById('file-q').files[0];
      if (!fileQ) {
        showMsg('문제 또는 모범답안 PDF를 업로드해주세요.');
        return;
      }

      convertAiLoading = true;
      let textQ = '';
      const images = [];

      try {
        showLoading('AI가 PDF 정밀 분석 중입니다...');
        try {
          const bufQ = await fileQ.arrayBuffer();
          const pdfQ = await pdfjsLib.getDocument(bufQ).promise;
          for (let i = 1; i <= pdfQ.numPages; i++) {
            const page = await pdfQ.getPage(i);
            const content = await page.getTextContent();
            const pText = content.items.map((it) => it.str).join(' ');
            textQ += pText + '\n';
            if (pText.trim().length < 50 && images.length < 3) {
              const vp = page.getViewport({ scale: 1.5 });
              const canvas = document.createElement('canvas');
              const ctx = canvas.getContext('2d');
              canvas.height = vp.height;
              canvas.width = vp.width;
              await page.render({ canvasContext: ctx, viewport: vp }).promise;
              images.push(canvas.toDataURL('image/jpeg').split(',')[1]);
            }
          }
        } catch (e) {
          showMsg('PDF 읽기 오류. 정상적인 파일인지 확인해주세요.');
          return;
        }

        tempConvertType = document.getElementById('convert-type').value;
        tempConvertSubject = document.getElementById('convert-subject').value;
        const subject = String(tempConvertSubject || '').trim();
        if (!subject || subject.length > 100) {
          showMsg(!subject ? '과목을 선택해주세요.' : '입력 길이가 너무 깁니다.');
          return;
        }

        const sourceText = textQ.trim().substring(0, 3000);
        if (!sourceText && images.length === 0) {
          showMsg('분석할 텍스트가 없습니다. PDF인 경우 텍스트 추출이 거의 되지 않았을 수 있습니다.');
          return;
        }

        const data = await processAiConvertViaServer({
          subject,
          mode: tempConvertType,
          sourceText,
          images: images.length ? images.slice(0, 3) : undefined,
        });
        tempConvertResults = data.results || [];
        renderConvertPreview();
        showMsg('✨ PDF 추출 완료! 내용을 검토해주세요.');
      } catch (e) {
        showMsg(e.message || String(e));
      } finally {
        hideLoading();
        convertAiLoading = false;
      }
    }

    async function processAIConvert() {
      if (getConvertInputMode() === 'text') {
        processTextDirectConvert();
        return;
      }
      await processPdfAiConvert();
    }

    function handleFileDisplay(type) {
      const file = document.getElementById('file-'+type).files[0];
      if(file) document.getElementById('file-'+type+'-name').innerHTML = `<span class="text-emerald-500 font-bold">✅ ${file.name}</span>`;
    }

    function renderConvertPreview() {
        const area = document.getElementById('convert-preview-area');
        const list = document.getElementById('convert-preview-list');
        list.innerHTML = '';
        area.classList.remove('hidden');

        if (tempConvertResults.length === 0) {
            list.innerHTML = '<p class="text-sm text-gray-500">추출된 결과가 없습니다.</p>';
            return;
        }

        tempConvertResults.forEach((item, index) => {
            if (tempConvertType === 'exam') {
                const eq = escapeHtml(item.question ?? '');
                const er = escapeHtml(item.rubric ?? '');
                list.innerHTML += `
                    <div class="p-4 border border-emerald-200 bg-emerald-50/30 rounded-xl preview-item relative" data-index="${index}">
                        <button onclick="removePreviewItem(${index})" class="absolute top-3 right-3 text-red-400 hover:text-red-600"><i class="ri-delete-bin-line"></i></button>
                        <div class="mb-3 pr-6"><label class="text-[10px] font-bold text-emerald-600 uppercase tracking-wider mb-1 block">문제 (Question)</label><textarea class="w-full p-3 text-[13px] border border-emerald-100 rounded-lg outline-none resize-y min-h-[80px] edit-q bg-white focus:ring-1 focus:ring-emerald-300 leading-relaxed">${eq}</textarea></div>
                        <div><label class="text-[10px] font-bold text-emerald-600 uppercase tracking-wider mb-1 block">채점 기준 및 모범답안 (Rubric)</label><textarea class="w-full p-3 text-[13px] border border-emerald-100 rounded-lg outline-none resize-y min-h-[120px] edit-r bg-white focus:ring-1 focus:ring-emerald-300 leading-relaxed">${er}</textarea></div>
                    </div>
                `;
            } else {
                const ef = escapeHtml(item.front ?? '');
                const eb = escapeHtml(item.back ?? '');
                list.innerHTML += `
                    <div class="p-4 border border-blue-200 bg-blue-50/30 rounded-xl preview-item relative" data-index="${index}">
                        <button onclick="removePreviewItem(${index})" class="absolute top-3 right-3 text-red-400 hover:text-red-600"><i class="ri-delete-bin-line"></i></button>
                        <div class="mb-3 pr-6"><label class="text-[10px] font-bold text-blue-600 uppercase tracking-wider mb-1 block">앞면 (질문/키워드)</label><input type="text" class="w-full p-2 text-[13px] font-bold border border-blue-100 rounded-lg outline-none edit-f bg-white focus:ring-1 focus:ring-blue-300" value="${ef}"></div>
                        <div><label class="text-[10px] font-bold text-blue-600 uppercase tracking-wider mb-1 block">뒷면 (정답 - 빈칸은 [대괄호] 처리)</label><textarea class="w-full p-3 text-[13px] border border-blue-100 rounded-lg outline-none resize-y min-h-[80px] edit-b bg-white focus:ring-1 focus:ring-blue-300 leading-relaxed">${eb}</textarea></div>
                    </div>
                `;
            }
        });
        
        area.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function removePreviewItem(index) {
        tempConvertResults.splice(index, 1);
        renderConvertPreview();
        if (tempConvertResults.length === 0) cancelConvert();
    }

    function cancelConvert() {
        convertAiLoading = false;
        tempConvertResults = [];
        document.getElementById('convert-preview-area').classList.add('hidden');
        document.getElementById('file-q').value = '';
        document.getElementById('file-q-name').innerText = 'PDF 업로드';
        document.getElementById('text-q').value = '';
    }

    function saveConvertedData() {
        const items = document.querySelectorAll('.preview-item');
        let savedCount = 0;

        items.forEach(el => {
            if (tempConvertType === 'exam') {
                const q = el.querySelector('.edit-q').value.trim();
                const r = el.querySelector('.edit-r').value.trim();
                if (q) {
                    db.questions.push({ id: Date.now().toString() + '-' + Math.floor(Math.random() * 1000000), subject: tempConvertSubject, question: q, rubric: r });
                    savedCount++;
                }
            } else {
                const f = el.querySelector('.edit-f').value.trim();
                const b = el.querySelector('.edit-b').value.trim();
                if (f && b) {
                    db.flashcards.push({ id: Date.now().toString() + '-' + Math.floor(Math.random() * 1000000), subject: tempConvertSubject, front: f, back: b, repetition: 0, interval: 0, efactor: 2.5, nextReview: getLocalNow() });
                    savedCount++;
                }
            }
        });

        if (savedCount > 0) {
            saveDB();
            if (tempConvertType === 'exam') updateExamQList();
            if (tempConvertType === 'flashcard') renderDueFlashcards();
            showMsg(`✅ ${savedCount}개 항목이 성공적으로 저장되었습니다!`);
        } else {
            showMsg(`저장할 항목이 없습니다.`);
        }
        cancelConvert();
    }

    function parseCSV(text) {
      let result = []; let row = []; let inQuotes = false; let value = "";
      for (let i = 0; i < text.length; i++) {
        let char = text[i]; let nextChar = text[i + 1];
        if (char === '"' && inQuotes && nextChar === '"') { value += '"'; i++; } 
        else if (char === '"') { inQuotes = !inQuotes; } 
        else if (char === ',' && !inQuotes) { row.push(value.trim()); value = ""; } 
        else if ((char === '\n' || char === '\r') && !inQuotes) {
          if (char === '\r' && nextChar === '\n') i++;
          row.push(value.trim()); value = "";
          if (row.length > 0 && row.some(v => v !== "")) result.push(row);
          row = [];
        } else { value += char; }
      }
      if (value || row.length > 0) { row.push(value.trim()); result.push(row); }
      return result;
    }

    function toggleCsvUploadForm() { document.getElementById('fc-manager-view').classList.add('hidden'); document.getElementById('manual-card-form').classList.add('hidden'); document.getElementById('csv-upload-form').classList.toggle('hidden'); }
    function cancelCsvUpload() { document.getElementById('csv-upload-form').classList.add('hidden'); }

    function processCsvUpload() {
      const file = document.getElementById('csv-file-input').files[0];
      if (!file) { showMsg("CSV 파일을 선택해주세요."); return; }
      const reader = new FileReader();
      reader.onload = function(e) {
        let text = e.target.result;
        if (text.includes('')) {
          const readerEuc = new FileReader();
          readerEuc.onload = function(e2) { executeCsvParsing(e2.target.result); };
          readerEuc.readAsText(file, "EUC-KR");
        } else { executeCsvParsing(text); }
      };
      reader.readAsText(file, "UTF-8");
    }

    function executeCsvParsing(text) {
      const rows = parseCSV(text); let addedCount = 0; let startIndex = 0;
      if (rows.length > 0 && rows[0][0] && (rows[0][0].includes("과목") || rows[0][1]?.includes("앞면"))) startIndex = 1; 
      for (let i = startIndex; i < rows.length; i++) {
        if (rows[i].length >= 3) {
          let subject = rows[i][0].trim(); let front = rows[i][1].trim(); let back = rows[i][2].trim();
          if(subject.includes('노동')) subject = '노동법'; else if(subject.includes('인사') || subject.includes('노무')) subject = '인사노무관리'; else if(subject.includes('행정') || subject.includes('쟁송')) subject = '행정쟁송법'; else if(subject.includes('민사') || subject.includes('민소')) subject = '민사소송법';
          if (front && back) {
            db.flashcards.push({ id: Date.now().toString() + '-' + Math.floor(Math.random() * 1000000), subject: subject, front: front, back: back, repetition: 0, interval: 0, efactor: 2.5, nextReview: getLocalNow() });
            addedCount++;
          }
        }
      }
      if (addedCount > 0) {
        saveDB(); renderDueFlashcards();
        if (!document.getElementById('fc-manager-view').classList.contains('hidden')) renderFcList();
        showMsg(`✅ ${addedCount}개의 플래시카드가 등록되었습니다!`); cancelCsvUpload(); document.getElementById('csv-file-input').value = "";
      } else showMsg("유효한 데이터가 없습니다.");
    }

    async function getFcHint() {
      if (!currentCard) return;
      const btn = document.getElementById('fc-hint-btn');
      const resEl = document.getElementById('fc-ai-result');

      await runAiButtonAction({
        button: btn,
        getBusy: () => fcHintLoading,
        setBusy: (v) => { fcHintLoading = v; },
        loadingLabel: (sec) =>
          sec < 5 ? '힌트 생성 중…' :
          sec < 10 ? '조금 더 걸리고 있어요…' :
                     '응답 대기 중…',
        execute: async () =>
          getFcHintViaServer({
            subject: currentCard.subject,
            front: currentCard.front,
            back: currentCard.back,
          }),
        isEmptyResult: (r) => !String(r?.hint || '').trim(),
        emptyFallback: '힌트를 만들지 못했습니다. 잠시 후 다시 시도해주세요.',
        onSuccess: (res) => {
          resEl.classList.remove('hidden');
          resEl.innerHTML = `<strong class="text-purple-600 block mb-1"><i class="ri-lightbulb-flash-line"></i> AI 힌트:</strong> ${escapeHtml(res.hint)}`;
        },
        onError: (msg) => {
          resEl.classList.remove('hidden');
          resEl.innerHTML = `<span class="text-red-500">${escapeHtml(msg)}</span>`;
        },
      });
    }

    async function getFcMnemonic() {
      if (!currentCard) return;
      const btn = document.getElementById('fc-mnemonic-btn');
      const resEl = document.getElementById('fc-ai-result');

      await runAiButtonAction({
        button: btn,
        getBusy: () => fcMnemonicLoading,
        setBusy: (v) => { fcMnemonicLoading = v; },
        loadingLabel: (sec) =>
          sec < 5 ? '암기비법 생성 중…' :
          sec < 10 ? '조금 더 걸리고 있어요…' :
                     '응답 대기 중…',
        execute: async () =>
          getFcMnemonicViaServer({
            subject: currentCard.subject,
            front: currentCard.front,
            back: currentCard.back,
          }),
        isEmptyResult: (r) => !String(r?.mnemonic || '').trim(),
        emptyFallback: '암기비법을 만들지 못했습니다. 잠시 후 다시 시도해주세요.',
        onSuccess: (res) => {
          resEl.classList.remove('hidden');
          resEl.innerHTML = `<strong class="text-blue-600 block mb-1"><i class="ri-magic-line"></i> AI 암기비법:</strong> ${escapeHtml(res.mnemonic)}`;
        },
        onError: (msg) => {
          resEl.classList.remove('hidden');
          resEl.innerHTML = `<span class="text-red-500">${escapeHtml(msg)}</span>`;
        },
      });
    }

    async function askAITutor() {
      if (!currentCard || fcTutorLoading) return;
      const question = document.getElementById('fc-ask-input').value.trim();
      if (!question) { showMsg("질문을 입력해주세요."); return; }

      const subject = String(currentCard.subject || '').trim();
      const front = String(currentCard.front || '').trim();
      const back = String(currentCard.back || '').trim();
      if (!subject || !front || !back) {
        showMsg('카드 정보가 불완전합니다.');
        return;
      }
      if (subject.length > 100 || front.length > 500 || back.length > 1000 || question.length > 600) {
        showMsg('입력 길이가 너무 깁니다.');
        return;
      }

      fcTutorLoading = true;
      const resEl = document.getElementById('fc-ask-result');
      resEl.classList.remove('hidden');
      resEl.innerHTML = '<div class="text-center text-slate-400 font-bold animate-pulse py-1">✨ AI 튜터가 답변을 작성 중입니다...</div>';

      try {
        const res = await askAiTutorViaServer({ subject, front, back, question });
        resEl.innerHTML = `<strong class="text-slate-800 block mb-1">A.</strong> ${escapeHtml(res.answer).replace(/\n/g, '<br>')}`;
      } catch(e) {
        resEl.innerHTML = `<span class="text-red-500">오류 발생: ${escapeHtml(e.message)}</span>`;
      } finally {
        fcTutorLoading = false;
      }
    }

    function toggleFcManager() { const view = document.getElementById('fc-manager-view'); view.classList.toggle('hidden'); if (!view.classList.contains('hidden')) { renderFcList(); document.getElementById('manual-card-form').classList.add('hidden'); document.getElementById('csv-upload-form').classList.add('hidden'); } }

    function renderFcList() {
      const container = document.getElementById('fc-list'); const filter = document.getElementById('fc-filter-subject').value;
      const selectAllCb = document.getElementById('fc-select-all'); if(selectAllCb) selectAllCb.checked = false;
      let filteredCards = filter === 'all' ? db.flashcards : db.flashcards.filter(c => c.subject === filter);
      if(filteredCards.length === 0) { container.innerHTML = '<p class="text-sm text-gray-400 py-4 text-center">등록된 카드가 없습니다.</p>'; return; }
      container.innerHTML = filteredCards.map((c, index) => `
        <div class="flex justify-between items-center p-2.5 md:p-3 bg-gray-50 border border-gray-100 rounded-lg hover:border-emerald-300 transition-colors">
           <div class="flex items-center gap-2 md:gap-3 flex-1 min-w-0 pr-2">
             <input type="checkbox" class="fc-item-checkbox rounded text-emerald-500 focus:ring-emerald-500 border-gray-300 w-4 h-4 cursor-pointer" value="${c.id}" onchange="updateSelectAllFcState()">
             <span class="text-[10px] md:text-xs font-bold text-gray-400 w-4 md:w-5 text-center shrink-0">${index + 1}</span>
             <div class="min-w-0">
               <span class="text-[9px] md:text-[10px] font-bold text-emerald-500 bg-emerald-50 px-1.5 py-0.5 rounded">${c.subject}</span>
               <p class="font-bold text-xs md:text-sm text-slate-800 mt-1 truncate">${c.front}</p>
             </div>
           </div>
           <div class="flex gap-1 md:gap-2 shrink-0">
              <button onclick="editFc('${c.id}')" class="px-2 py-1 md:px-3 md:py-1.5 bg-white border border-gray-200 text-slate-600 rounded text-[10px] md:text-xs font-bold hover:bg-gray-100">수정</button>
              <button onclick="deleteFc('${c.id}')" class="px-2 py-1 md:px-3 md:py-1.5 border border-red-100 text-red-500 rounded text-[10px] md:text-xs font-bold hover:bg-red-50">삭제</button>
           </div>
        </div>
      `).join('');
    }

    function toggleSelectAllFc(source) { document.querySelectorAll('.fc-item-checkbox').forEach(cb => cb.checked = source.checked); }
    function updateSelectAllFcState() { const cbs = document.querySelectorAll('.fc-item-checkbox'); const allCb = document.getElementById('fc-select-all'); if (allCb && cbs.length > 0) allCb.checked = Array.from(cbs).every(cb => cb.checked); }

    function removeBracketsFromSelected() {
      const selectedIds = Array.from(document.querySelectorAll('.fc-item-checkbox:checked')).map(cb => cb.value);
      if (selectedIds.length === 0) { showMsg("선택된 카드가 없습니다."); return; }
      customConfirm(`선택한 ${selectedIds.length}개 카드의 대괄호를 지우시겠습니까?`, () => {
        let count = 0;
        db.flashcards.forEach(c => { if (selectedIds.includes(String(c.id))) { if (c.back.includes('[') || c.back.includes(']')) { c.back = c.back.replace(/\[/g, '').replace(/\]/g, count++); } } });
        if(count > 0) { saveDB(); renderFcList(); renderDueFlashcards(); showMsg(`✅ ${count}개의 카드가 변환되었습니다!`); }
      });
    }

    function deleteSelectedFc() {
      const selectedIds = Array.from(document.querySelectorAll('.fc-item-checkbox:checked')).map(cb => cb.value);
      if (selectedIds.length === 0) { showMsg("선택된 카드가 없습니다."); return; }
      customConfirm(`선택한 ${selectedIds.length}개의 카드를 삭제하시겠습니까?`, () => {
        db.flashcards = db.flashcards.filter(c => !selectedIds.includes(String(c.id)));
        saveDB(); renderFcList(); renderDueFlashcards(); showMsg(`${selectedIds.length}개의 카드가 일괄 삭제되었습니다.`);
      });
    }

    function deleteFc(id) { 
      customConfirm('해당 카드를 삭제하시겠습니까?', () => {
        db.flashcards = db.flashcards.filter(c => String(c.id) !== String(id)); saveDB(); renderFcList(); renderDueFlashcards(); showMsg("카드가 삭제되었습니다."); 
      });
    }

    function editFc(id) {
      const c = db.flashcards.find(x => String(x.id) === String(id)); if(!c) return; editingFcId = c.id;
      document.getElementById('manual-fc-title').innerHTML = '<i class="ri-edit-2-line text-emerald-500"></i> 플래시카드 수정하기';
      document.getElementById('manual-fc-subject').value = c.subject; document.getElementById('manual-fc-front').value = c.front; document.getElementById('manual-fc-back').value = c.back;
      document.getElementById('manual-fc-save-btn').textContent = '수정 완료';
      document.getElementById('manual-card-form').classList.remove('hidden'); document.getElementById('fc-manager-view').classList.add('hidden'); document.getElementById('csv-upload-form').classList.add('hidden');
    }

    function toggleManualCardForm() {
      editingFcId = null; document.getElementById('manual-fc-title').innerHTML = '<i class="ri-edit-circle-line text-emerald-500"></i> 새 플래시카드 입력';
      document.getElementById('manual-fc-front').value = ''; document.getElementById('manual-fc-back').value = ''; document.getElementById('manual-fc-save-btn').textContent = '추가하기';
      document.getElementById('fc-manager-view').classList.add('hidden'); document.getElementById('csv-upload-form').classList.add('hidden'); document.getElementById('manual-card-form').classList.toggle('hidden');
    }

    function cancelManualFlashcard() { editingFcId = null; document.getElementById('manual-card-form').classList.add('hidden'); }

    function addManualFlashcard() {
      try {
        const subject = document.getElementById('manual-fc-subject').value; const front = document.getElementById('manual-fc-front').value.trim(); const back = document.getElementById('manual-fc-back').value.trim();
        if (!front || !back) { showMsg('⚠️ 앞면과 뒷면을 모두 입력해주세요.'); return; }
        if (editingFcId) {
          const idx = db.flashcards.findIndex(x => String(x.id) === String(editingFcId));
          if(idx > -1) { db.flashcards[idx].subject = subject; db.flashcards[idx].front = front; db.flashcards[idx].back = back; }
          editingFcId = null; showMsg('✅ 카드가 수정되었습니다!');
        } else {
          db.flashcards.push({ id: Date.now().toString() + '-' + Math.floor(Math.random() * 1000000), subject, front, back, repetition: 0, interval: 0, efactor: 2.5, nextReview: getLocalNow() });
          showMsg('✅ 카드가 추가되었습니다!');
        }
        saveDB(); document.getElementById('manual-card-form').classList.add('hidden'); renderDueFlashcards();
      } catch(e) { showMsg("카드 저장 오류: " + e.message); }
    }

    function renderDueFlashcards() {
      dueCards = db.flashcards.filter(isDue);
      document.getElementById('fc-due-display').textContent = dueCards.length;
      if (dueCards.length > 0) { 
        document.getElementById('fc-workspace').classList.remove('hidden'); 
        document.getElementById('fc-empty').classList.add('hidden'); 
        loadNextCard(); 
      } else { 
        document.getElementById('fc-workspace').classList.add('hidden'); 
        document.getElementById('fc-empty').classList.remove('hidden'); 
      }
    }

    function loadNextCard() {
      // 💡 카운트 즉각 반영
      document.getElementById('fc-due-display').textContent = dueCards.length;

      if (dueCards.length === 0) { renderDueFlashcards(); return; }
      currentCard = dueCards[0];
      fcTutorLoading = false;

      document.getElementById('fc-buttons').classList.add('hidden');
      document.querySelectorAll('#fc-buttons .sm2-btn').forEach(btn => btn.classList.remove('ring-4', 'ring-offset-2', 'ring-rose-400', 'ring-orange-400', 'ring-blue-400', 'ring-emerald-400', 'animate-pulse'));
      
      const aiResult = document.getElementById('fc-ai-result');
      if(aiResult) { aiResult.classList.add('hidden'); aiResult.innerHTML = ''; }
      
      if(document.getElementById('fc-ask-input')) document.getElementById('fc-ask-input').value = '';
      if(document.getElementById('fc-ask-result')) document.getElementById('fc-ask-result').classList.add('hidden');

      let e = currentCard.efactor || 2.5; let r = currentCard.repetition || 0; let iv = currentCard.interval || 0;
      let nextGood = r === 0 ? 1 : (r === 1 ? 6 : Math.round(iv * e));
      let nextEasy = r === 0 ? 4 : Math.round(nextGood * 1.3);

      document.getElementById('fc-time-good').textContent = `${nextGood}일 후`;
      document.getElementById('fc-time-easy').textContent = `${nextEasy}일 후`;

      let reviewCount = currentCard.reviews !== undefined ? currentCard.reviews : (currentCard.repetition || 0);
      let statusHtml = reviewCount === 0 ? '🆕 처음' : `🔁 ${reviewCount}회독`;
      let statusClassFlip = reviewCount === 0 ? 'text-indigo-600 bg-indigo-50' : 'text-slate-500 bg-slate-100';
      let statusClassCloze = reviewCount === 0 ? 'text-indigo-600 bg-indigo-50' : 'text-slate-500 bg-slate-100';

      document.getElementById('fc-front-status').textContent = statusHtml;
      document.getElementById('fc-front-status').className = `text-[10px] md:text-xs font-bold px-2 md:px-3 py-1 rounded-full shrink-0 ${statusClassFlip}`;
      document.getElementById('fc-cloze-status').textContent = statusHtml;
      document.getElementById('fc-cloze-status').className = `text-[10px] md:text-xs font-bold px-2 py-1 rounded-full inline-block ${statusClassCloze}`;

      const hasCloze = /\[(.*?)\]/.test(currentCard.back);
      if (hasCloze) {
        document.getElementById('fc-flip-container').classList.add('hidden'); document.getElementById('fc-cloze-container').classList.remove('hidden');
        renderFcClozeCard(currentCard);
      } else {
        document.getElementById('fc-cloze-container').classList.add('hidden'); document.getElementById('fc-flip-container').classList.remove('hidden');
        document.getElementById('fc-card').classList.remove('flipped');
        document.getElementById('fc-front-sub').textContent = currentCard.subject || ''; document.getElementById('fc-front-text').textContent = currentCard.front || ''; document.getElementById('fc-back-text').textContent = currentCard.back || '';
      }
    }

    function normalizeFcClozeBackText(back) {
      const s = String(back || '').replace(/\r\n/g, '\n');
      if (!s.includes('\n') && /\d+\.\s/.test(s)) {
        return s.replace(/\s+(?=\d+\.\s)/g, '\n');
      }
      return s;
    }

    function renderFcClozeCard(card) {
      document.getElementById('fc-cloze-sub').textContent = card.subject || ''; document.getElementById('fc-cloze-front').textContent = card.front || '';
      document.getElementById('fc-cloze-check-btn').classList.remove('hidden');
      
      const container = document.getElementById('fc-cloze-back');
      const backText = normalizeFcClozeBackText(card.back);
      const regex = /\[(.*?)\]/g; let html = ''; let match; let lastIdx = 0; fcClozeState.answers = [];

      let matches = []; let tempMatch; const tempRegex = /\[(.*?)\]/g;
      while ((tempMatch = tempRegex.exec(backText)) !== null) { matches.push(tempMatch[1]); }
      const maxCharLen = matches.length > 0 ? Math.max(...matches.map(x => x.length)) : 10;
      const uniformWidth = `clamp(60px, ${maxCharLen + 2}ch, 100%)`;

      while ((match = regex.exec(backText)) !== null) {
        html += escapeHtml(backText.substring(lastIdx, match.index));
        const ans = match[1].trim(); fcClozeState.answers.push(ans);
        html += `<input type="text" class="fc-blank-input blank-input" data-answer="${escapeHtml(ans)}" style="width: ${uniformWidth};" onclick="setFcActiveInput(this)" placeholder="">`;
        lastIdx = regex.lastIndex;
      }
      html += escapeHtml(backText.substring(lastIdx)); container.innerHTML = html;

      const bank = document.getElementById('fc-cloze-word-bank'); bank.innerHTML = '';
      const shuffled = [...fcClozeState.answers].sort(() => Math.random() - 0.5);
      shuffled.forEach(ans => { const safeAns = ans.replace(/'/g, "\\'"); bank.innerHTML += `<div class="word-chip" onclick="fillFcWordChip('${safeAns}')">${ans}</div>`; });

      const inputs = container.querySelectorAll('.fc-blank-input');
      inputs.forEach(input => { input.addEventListener('focus', (e) => { setFcActiveInput(e.target); }); input.addEventListener('input', (e) => { e.target.classList.remove('correct', 'wrong'); }); });
      fcClozeState.activeInput = null; if(inputs.length > 0) inputs[0].focus();
    }

    function setFcActiveInput(el) { fcClozeState.activeInput = el; el.classList.remove('correct', 'wrong'); }
    function fillFcWordChip(word) {
      if (fcClozeState.activeInput) {
        fcClozeState.activeInput.value = word; fcClozeState.activeInput.classList.remove('correct', 'wrong');
        const inputs = Array.from(document.querySelectorAll('#fc-cloze-back .fc-blank-input'));
        const nextEmpty = inputs.slice(inputs.indexOf(fcClozeState.activeInput) + 1).find(i => !i.value) || inputs.find(i => !i.value);
        if (nextEmpty) nextEmpty.focus();
      } else { showMsg("먼저 채워넣을 빈칸을 클릭해주세요."); }
    }

    function checkFcClozeAnswers() {
      const inputs = document.querySelectorAll('#fc-cloze-back .fc-blank-input'); let correctCount = 0;
      inputs.forEach(input => {
        const actual = input.dataset.answer.replace(/\s+/g, ''); const user = input.value.replace(/\s+/g, '');
        if (actual === user) { input.classList.add('correct'); input.classList.remove('wrong'); input.placeholder = ''; correctCount++; } 
        else { input.classList.add('wrong'); input.classList.remove('correct'); if (!input.value) input.placeholder = "?"; }
      });

      document.getElementById('fc-cloze-check-btn').classList.add('hidden'); 
      const btnContainer = document.getElementById('fc-buttons');
      btnContainer.classList.remove('hidden');
      btnContainer.classList.add('grid');
      
      const accuracy = inputs.length > 0 ? (correctCount / inputs.length) : 0;
      document.querySelectorAll('#fc-buttons .sm2-btn').forEach(btn => btn.classList.remove('ring-4', 'ring-offset-2', 'ring-rose-400', 'ring-orange-400', 'ring-blue-400', 'ring-emerald-400', 'animate-pulse'));

      if (accuracy === 1) { document.getElementById('fc-btn-easy').classList.add('ring-4', 'ring-offset-2', 'ring-emerald-400', 'animate-pulse'); showMsg("🎉 100% 완벽! '쉬움'을 추천합니다."); } 
      else if (accuracy >= 0.75) { document.getElementById('fc-btn-good').classList.add('ring-4', 'ring-offset-2', 'ring-blue-400', 'animate-pulse'); showMsg("👍 75% 이상 정답! '보통'을 추천합니다."); } 
      else if (accuracy >= 0.25) { document.getElementById('fc-btn-hard').classList.add('ring-4', 'ring-offset-2', 'ring-orange-400', 'animate-pulse'); showMsg("🔥 25%~75% 정답. '어려움'을 추천합니다."); } 
      else { document.getElementById('fc-btn-again').classList.add('ring-4', 'ring-offset-2', 'ring-rose-400', 'animate-pulse'); showMsg("💪 25% 미만 정답. 다시 한 번 확실히 외워봅시다!"); }
    }

    function flipCard() { 
      document.getElementById('fc-card').classList.add('flipped'); 
      const btnContainer = document.getElementById('fc-buttons');
      btnContainer.classList.remove('hidden');
      btnContainer.classList.add('grid');
    }

    function rateCard(rating) {
      let q = rating === 1 ? 0 : rating === 2 ? 3 : rating === 3 ? 4 : 5;
      let r = currentCard.repetition || 0; let iv = currentCard.interval || 0; let e = currentCard.efactor || 2.5;

      let nextGood = r === 0 ? 1 : (r === 1 ? 6 : Math.round(iv * e));
      let nextEasy = r === 0 ? 4 : Math.round(nextGood * 1.3);

      if (rating === 3) iv = nextGood;
      else if (rating === 4) iv = nextEasy;
      else if (rating === 2) iv = 0.5; 
      else iv = 0; 

      if (rating >= 3) r++; else r = 0;

      e = e + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)); if (e < 1.3) e = 1.3;
      currentCard.repetition = r; currentCard.interval = iv; currentCard.efactor = e;
      
      let currentReviewCount = currentCard.reviews !== undefined ? currentCard.reviews : (r === 0 ? 0 : r);
      currentCard.reviews = currentReviewCount + 1;

      let nextDate = new Date();
      if (iv === 0) {
        nextDate.setMinutes(nextDate.getMinutes() + 1);
        if(dueCards.length > 1) showMsg("카드 대기열 맨 뒤로 이동됨 (1분 후)");
      }
      else if (iv === 0.5) nextDate.setHours(nextDate.getHours() + 12);
      else {
        nextDate.setDate(nextDate.getDate() + iv);
        nextDate.setHours(0, 0, 0, 0); 
      }

      const tzOffset = nextDate.getTimezoneOffset() * 60000;
      currentCard.nextReview = (new Date(nextDate.getTime() - tzOffset)).toISOString().slice(0, 19);

      const idx = db.flashcards.findIndex(c => c.id === currentCard.id);
      if (idx > -1) db.flashcards[idx] = currentCard;
      
      saveDB(); 
      markStudiedToday('fc');
      dueCards.shift(); 
      if (rating === 1) dueCards.push(currentCard); 
      
      // 💡 즉각적인 화면 반영 (플래시카드 상단 배지 및 대시보드 잔여 수치)
      document.getElementById('fc-due-display').textContent = dueCards.length;
      const dueFcValEl = document.getElementById('due-fc-val');
      if (dueFcValEl) dueFcValEl.textContent = db.flashcards.filter(isDue).length;
      
      loadNextCard();
    }

    async function generateOutlineWithAI() {
      if (outlineAiLoading) return;
      const subject = document.getElementById('outline-subject').value.trim();
      const title = document.getElementById('outline-title').value.trim();
      if (!title) { showMsg("주제(제목)를 먼저 입력해주세요!"); return; }
      if (!subject) { showMsg("과목을 선택해주세요."); return; }
      if (subject.length > 100 || title.length > 200) { showMsg("입력 길이가 너무 깁니다."); return; }

      outlineAiLoading = true;
      showLoading("AI가 표준 목차 구조를 작성 중입니다...");
      try {
        const res = await generateOutlineViaServer({ subject, title });
        document.getElementById('outline-content').value = res.outline;
        showMsg("✨ AI 목차 자동 생성 완료!");
      } catch(e) { showMsg("목차 생성 실패: " + e.message); } finally { hideLoading(); outlineAiLoading = false; }
    }

    function toggleOutlineAdder() { 
      editingOutlineId = null; document.getElementById('outline-adder-title').innerHTML = '<i class="ri-file-list-line text-emerald-500"></i> 새 목차 구조 등록';
      document.getElementById('outline-save-btn').textContent = '등록하기'; document.getElementById('outline-title').value = ''; document.getElementById('outline-content').value = '';
      document.getElementById('outline-adder').classList.toggle('hidden'); 
    }
    function cancelOutlineEdit() { editingOutlineId = null; document.getElementById('outline-adder').classList.add('hidden'); }
    
    function editOutline(id) {
      const o = db.outlines.find(x => String(x.id) === String(id)); if(!o) return; editingOutlineId = o.id;
      document.getElementById('outline-adder-title').innerHTML = '<i class="ri-edit-line text-emerald-500"></i> 목차 내용 수정';
      document.getElementById('outline-subject').value = o.subject; document.getElementById('outline-title').value = o.title; document.getElementById('outline-content').value = o.content;
      document.getElementById('outline-save-btn').textContent = "수정 완료"; 
      const adder = document.getElementById('outline-adder');
      adder.classList.remove('hidden');
      adder.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    
    function saveOutline() {
      const subject = document.getElementById('outline-subject').value; const title = document.getElementById('outline-title').value.trim(); const content = document.getElementById('outline-content').value.trim();
      if (!title || !content) { showMsg("제목과 내용을 모두 입력해주세요."); return; }
      if (editingOutlineId) {
         const idx = db.outlines.findIndex(x => String(x.id) === String(editingOutlineId));
         if(idx > -1) { db.outlines[idx].subject = subject; db.outlines[idx].title = title; db.outlines[idx].content = content; }
         editingOutlineId = null; showMsg("목차가 수정되었습니다.");
      } else { db.outlines.push({ id: Date.now().toString() + '-' + Math.floor(Math.random() * 1000000), subject, title, content, repetition: 0, interval: 0, efactor: 2.5, nextReview: getLocalNow() }); showMsg("새 목차가 등록되었습니다."); }
      saveDB(); document.getElementById('outline-title').value = ''; document.getElementById('outline-content').value = ''; document.getElementById('outline-adder').classList.add('hidden'); renderOutlineList(); 
    }
    
    function renderOutlineList() {
      const container = document.getElementById('outline-list');
      const filterEl = document.getElementById('outline-filter-subject');
      const filter = filterEl ? filterEl.value : 'all';
      
      let filteredOutlines = db.outlines || [];
      if (filter !== 'all') { filteredOutlines = filteredOutlines.filter(o => o.subject === filter); }

      if (filteredOutlines.length === 0) { container.innerHTML = '<p class="col-span-2 text-center text-gray-400 py-10">등록된 목차가 없습니다.</p>'; return; }
      container.innerHTML = filteredOutlines.map(o => {
        const isToday = isDue(o);
        return `
        <div class="p-4 md:p-6 bg-white border ${isToday ? 'border-amber-400 bg-amber-50/10' : 'border-gray-200'} rounded-xl shadow-sm flex flex-col justify-between hover:shadow-md transition-all group">
          <div>
            <div class="flex justify-between items-start">
              <span class="text-[9px] md:text-[10px] font-bold text-amber-500 bg-amber-50 px-2 py-1 rounded-full">${o.subject}</span>
              ${isToday ? '<span class="text-[9px] md:text-[10px] font-bold text-white bg-amber-500 px-2 py-1 rounded-full animate-pulse">오늘 복습</span>' : ''}
            </div>
            <h4 class="font-extrabold text-slate-800 text-base md:text-lg mt-3 mb-2">${o.title}</h4>
          </div>
          <div class="flex justify-end gap-1 md:gap-2 mt-4">
            <button onclick="editOutline('${o.id}')" class="px-2 py-1.5 md:px-3 md:py-1.5 border border-gray-200 text-slate-600 rounded-lg text-xs font-bold hover:bg-gray-100">수정</button>
            <button onclick="deleteOutline('${o.id}')" class="px-2 py-1.5 md:px-3 md:py-1.5 border border-red-100 text-red-500 rounded-lg text-xs font-bold hover:bg-red-50">삭제</button>
            <button onclick="startBlankQuiz('${o.id}')" class="px-3 py-1.5 md:px-4 md:py-1.5 bg-amber-500 text-white rounded-lg text-xs font-bold hover:bg-amber-600 shadow-sm">퀴즈 시작</button>
          </div>
        </div>
      `}).join('');
    }

    function deleteOutline(id) { 
      customConfirm("해당 목차를 삭제하시겠습니까?", () => {
        db.outlines = db.outlines.filter(o => String(o.id) !== String(id)); saveDB(); renderOutlineList(); showMsg("삭제되었습니다."); 
      });
    }
    
    function startBlankQuiz(id) {
      blankState.outline = db.outlines.find(o => String(o.id) === String(id)); if(!blankState.outline) return;
      document.getElementById('blank-list-view').classList.add('hidden'); document.getElementById('blank-quiz-view').classList.remove('hidden');
      document.getElementById('quiz-subject').textContent = blankState.outline.subject; document.getElementById('quiz-title').textContent = blankState.outline.title;
      generateBlankQuiz();
    }
    function closeBlankQuiz() { 
      paragraphAiExpandLoading = false;
      document.getElementById('blank-quiz-view').classList.add('hidden'); 
      document.getElementById('blank-list-view').classList.remove('hidden'); 
      document.getElementById('quiz-ai-expand-btn').classList.add('hidden');
      document.getElementById('quiz-ai-expand-result').classList.add('hidden');
      renderOutlineList(); 
      renderDashboard(); 
    }
    
    function generateBlankQuiz() {
      const level = document.getElementById('quiz-level').value; 
      const lines = blankState.outline.content.split('\n'); 
      const regex = /^([\s]*[IVX]+\.|[\s]*[Ⅰ-Ⅻ]+\.?|[\s]*\d+[\.\)]|[\s]*\(\d+\)|[\s]*[①-⑳]|[\s]*[가-힣]+[\.\)]|[\s]*\([가-힣]+\)|[\s]*[㈎-㈛])(.*)$/;
      
      let parsedLines = lines.map((line, idx) => {
        let prefix = ''; let content = line; const match = line.match(regex);
        if (match) { prefix = match[1]; content = match[2].trim(); } else { const spaceMatch = line.match(/^(\s*)(.*)$/); if (spaceMatch) { prefix = spaceMatch[1]; content = spaceMatch[2]; } }
        return { id: idx, original: line, prefix, content, isBlank: false };
      });
      let candidates = parsedLines.filter(l => l.content.length > 0);
      if (level === 'all') candidates.forEach(l => l.isBlank = true);
      else if (level === '50') { candidates.sort(() => Math.random() - 0.5); candidates.slice(0, Math.ceil(candidates.length / 2)).forEach(l => l.isBlank = true); }
      else if (level === '30') { candidates.sort(() => Math.random() - 0.5); candidates.slice(0, Math.ceil(candidates.length * 0.3)).forEach(l => l.isBlank = true); }
      else if (level === 'main') candidates.forEach(l => { 
        if (l.prefix.match(/[IVX]+\.|[Ⅰ-Ⅻ]+\.?|\d+\.|[가-힣]+\./)) l.isBlank = true; 
      });

      parsedLines.sort((a,b) => a.id - b.id); blankState.lines = parsedLines; blankState.answers = parsedLines.filter(l => l.isBlank).map(l => l.content); blankState.answers.sort(() => Math.random() - 0.5); 
      
      let o = blankState.outline;
      let e = o.efactor || 2.5; let r = o.repetition || 0; let iv = o.interval || 0;
      let nextGood = r === 0 ? 1 : (r === 1 ? 6 : Math.round(iv * e));
      let nextEasy = r === 0 ? 4 : Math.round(nextGood * 1.3);
      document.getElementById('quiz-time-good').textContent = `${nextGood}일 후`;
      document.getElementById('quiz-time-easy').textContent = `${nextEasy}일 후`;

      let reviewCount = o.reviews !== undefined ? o.reviews : (r === 0 ? 0 : r);
      let statusHtml = reviewCount === 0 ? '🆕 처음' : `🔁 ${reviewCount}회독`;
      let statusClass = reviewCount === 0 ? 'text-indigo-600 bg-indigo-50' : 'text-slate-500 bg-slate-100';

      const statusEl = document.getElementById('quiz-status');
      if (statusEl) {
          statusEl.textContent = statusHtml;
          statusEl.className = `text-[10px] md:text-xs font-bold px-2 py-1 rounded-full inline-block shrink-0 ${statusClass}`;
      }
      
      document.getElementById('quiz-ai-expand-btn').classList.add('hidden');
      document.getElementById('quiz-ai-expand-result').classList.add('hidden');
      renderBlankQuizRoom();
    }
    
    function renderBlankQuizRoom() {
      const container = document.getElementById('quiz-lines'); container.innerHTML = '';
      const blankLines = blankState.lines.filter(l => l.isBlank); const maxCharLen = blankLines.length > 0 ? Math.max(...blankLines.map(l => l.content.length)) : 10; 
      const uniformWidth = `clamp(80px, ${maxCharLen + 2}ch, 100%)`;

      blankState.lines.forEach(line => {
        let indentClass = '';
        let textClass = 'text-[13px] md:text-[15px] font-medium text-slate-700';
        let prefixClass = 'font-bold text-slate-500';
        let inputClass = '';
        
        const p = line.prefix.trim();
        // 💡 계층별 들여쓰기 자동 적용 (Ⅰ - 1 - (1) - 1) - ① - ㈎)
        if (/^[IVX]+\.|^[Ⅰ-Ⅻ]+\.?/.test(p)) {
            indentClass = 'ml-0 mt-6 mb-3';
            textClass = 'text-base md:text-lg font-extrabold text-slate-800';
            prefixClass = 'text-emerald-600';
            inputClass = 'font-extrabold text-emerald-700';
        } else if (/^\d+\./.test(p)) {
            indentClass = 'ml-4 md:ml-6 mt-3 mb-2';
            textClass = 'text-[14px] md:text-[16px] font-bold text-slate-700';
        } else if (/^\(\d+\)/.test(p)) {
            indentClass = 'ml-8 md:ml-12 mb-2';
        } else if (/^\d+\)/.test(p)) {
            indentClass = 'ml-12 md:ml-16 mb-1.5';
            textClass = 'text-[12px] md:text-[14px] font-medium text-slate-600';
        } else if (/^[①-⑳]/.test(p)) {
            indentClass = 'ml-16 md:ml-20 mb-1';
            textClass = 'text-[12px] md:text-[14px] font-medium text-slate-600';
        } else if (/^[가-힣]+\.|^\([가-힣]+\)|^[㈎-㈛]/.test(p)) {
            indentClass = 'ml-20 md:ml-24 mb-1';
            textClass = 'text-[12px] md:text-[14px] font-medium text-slate-600';
        } else {
            indentClass = 'ml-4 md:ml-6 mb-1'; // 기본 여백
        }

        const row = document.createElement('div'); 
        row.className = `flex items-center flex-wrap ${indentClass} ${textClass}`; 
        
        const prefixSpan = document.createElement('span'); 
        prefixSpan.textContent = line.prefix; 
        prefixSpan.className = `mr-2 shrink-0 ${prefixClass}`; 
        row.appendChild(prefixSpan);
        
        if (line.isBlank) {
          const input = document.createElement('input'); input.type = "text"; 
          input.className = `blank-input ${inputClass}`; 
          input.dataset.answer = line.content; input.style.width = uniformWidth;
          if (/^[IVX]+\.|^[Ⅰ-Ⅻ]+\.?/.test(p)) input.style.fontSize = 'inherit';
          
          input.addEventListener('focus', (e) => { blankState.activeInput = e.target; e.target.classList.remove('correct', 'wrong'); });
          input.addEventListener('input', (e) => { e.target.classList.remove('correct', 'wrong'); }); row.appendChild(input);
        } else { 
          const contentSpan = document.createElement('span'); contentSpan.textContent = line.content; row.appendChild(contentSpan); 
        }
        container.appendChild(row);
      });
      
      const bankContainer = document.getElementById('quiz-word-bank'); bankContainer.innerHTML = '';
      blankState.answers.forEach(ans => {
        const chip = document.createElement('div'); chip.className = "word-chip"; chip.textContent = ans; chip.onclick = () => fillWordChipOutline(ans); bankContainer.appendChild(chip);
      });
      blankState.activeInput = null; const firstInput = document.querySelector('.blank-input'); if(firstInput) firstInput.focus();
      document.getElementById('quiz-check-btn').classList.remove('hidden');
      document.getElementById('quiz-sm2-buttons').classList.add('hidden');
      document.getElementById('quiz-sm2-buttons').classList.remove('grid');
    }
    
    function fillWordChipOutline(word) {
      if (blankState.activeInput) {
        blankState.activeInput.value = word; blankState.activeInput.classList.remove('correct', 'wrong');
        const inputs = Array.from(document.querySelectorAll('#quiz-lines .blank-input'));
        const nextEmpty = inputs.slice(inputs.indexOf(blankState.activeInput) + 1).find(i => !i.value) || inputs.find(i => !i.value);
        if (nextEmpty) nextEmpty.focus();
      } else { showMsg("먼저 채워넣을 빈칸을 터치(클릭)해주세요."); }
    }
    
    function checkBlankAnswers() {
      const inputs = document.querySelectorAll('#quiz-lines .blank-input'); let correctCount = 0;
      inputs.forEach(input => {
        const actual = input.dataset.answer.replace(/\s+/g, ''); const user = input.value.replace(/\s+/g, '');
        if (actual === user) { input.classList.add('correct'); input.classList.remove('wrong'); input.placeholder = ''; correctCount++; } 
        else { input.classList.add('wrong'); input.classList.remove('correct'); if (!input.value) input.placeholder = "?"; }
      });
      
      const accuracy = inputs.length > 0 ? (correctCount / inputs.length) : 0;
      document.querySelectorAll('#quiz-sm2-buttons .sm2-btn').forEach(btn => btn.classList.remove('ring-4', 'ring-offset-2', 'ring-rose-400', 'ring-orange-400', 'ring-blue-400', 'ring-emerald-400', 'animate-pulse'));

      if (accuracy === 1) { document.getElementById('quiz-btn-easy').classList.add('ring-4', 'ring-offset-2', 'ring-emerald-400', 'animate-pulse'); showMsg("🎉 100% 완벽! '쉬움'을 추천합니다."); } 
      else if (accuracy >= 0.75) { document.getElementById('quiz-btn-good').classList.add('ring-4', 'ring-offset-2', 'ring-blue-400', 'animate-pulse'); showMsg("👍 75% 이상 정답! '보통'을 추천합니다."); } 
      else if (accuracy >= 0.25) { document.getElementById('quiz-btn-hard').classList.add('ring-4', 'ring-offset-2', 'ring-orange-400', 'animate-pulse'); showMsg("🔥 25%~75% 정답. '어려움'을 추천합니다."); } 
      else { document.getElementById('quiz-btn-again').classList.add('ring-4', 'ring-offset-2', 'ring-rose-400', 'animate-pulse'); showMsg("💪 25% 미만 정답. 다시 한 번 확실히 외워봅시다!"); }
      
      document.getElementById('quiz-check-btn').classList.add('hidden');
      const btnContainer = document.getElementById('quiz-sm2-buttons');
      btnContainer.classList.remove('hidden');
      btnContainer.classList.add('grid');
      
      document.getElementById('quiz-ai-expand-btn').classList.remove('hidden');
    }

    async function generateParagraphFromOutline() {
      if (!blankState.outline) return;
      if (paragraphAiExpandLoading) return;
      const subject = String(blankState.outline.subject || '').trim();
      const title = String(blankState.outline.title || '').trim();
      const outline = String(blankState.outline.content || '').trim();
      if (!subject || !title || !outline) {
        showMsg('과목·제목·목차 정보가 필요합니다.');
        return;
      }
      if (subject.length > 100 || title.length > 200 || outline.length > 8000) {
        showMsg('입력 길이가 너무 깁니다.');
        return;
      }

      paragraphAiExpandLoading = true;
      const resEl = document.getElementById('quiz-ai-expand-result');
      resEl.classList.remove('hidden');
      resEl.innerHTML = '<div class="text-center text-purple-400 font-bold animate-pulse text-xs py-2">✨ AI가 목차를 바탕으로 답안을 전개 중입니다...</div>';

      try {
        const res = await generateParagraphViaServer({ subject, title, outline });
        resEl.innerHTML = `<strong class="text-purple-600 block mb-2"><i class="ri-quill-pen-fill"></i> AI 예시 답안:</strong> ${escapeHtml(res.paragraph).replace(/\n/g, '<br>')}`;
      } catch (e) {
        resEl.innerHTML = `<span class="text-red-500">오류 발생: ${escapeHtml(e.message)}</span>`;
      } finally {
        paragraphAiExpandLoading = false;
      }
    }

    function rateOutline(rating) {
      let outline = blankState.outline;
      let q = rating === 1 ? 0 : rating === 2 ? 3 : rating === 3 ? 4 : 5;
      let r = outline.repetition || 0; let iv = outline.interval || 0; let e = outline.efactor || 2.5;

      if (rating >= 3) {
        if (r === 0) iv = 1; else if (r === 1) iv = 6; else iv = Math.round(iv * e);
        r++;
      } else { iv = 0; r = 0; }

      e = e + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)); if (e < 1.3) e = 1.3;
      
      let currentReviewCount = outline.reviews !== undefined ? outline.reviews : (r === 0 ? 0 : r);
      outline.reviews = currentReviewCount + 1;

      let nextDate = new Date();
      if (iv === 0) nextDate.setMinutes(nextDate.getMinutes() + 1);
      else if (iv === 0.5) nextDate.setHours(nextDate.getHours() + 12);
      else nextDate.setDate(nextDate.getDate() + iv);

      outline.repetition = r; outline.interval = iv; outline.efactor = e;
      outline.nextReview = new Date(nextDate - nextDate.getTimezoneOffset()*60000).toISOString().slice(0,19);

      const idx = db.outlines.findIndex(o => o.id === outline.id);
      if (idx > -1) db.outlines[idx] = outline;
      saveDB(); 
      markStudiedToday('outline'); 
      
      // 💡 즉각적인 화면 반영 (대시보드 목차 잔여 수치)
      const dueOutlineValEl = document.getElementById('due-outline-val');
      if (dueOutlineValEl) dueOutlineValEl.textContent = db.outlines.filter(isDue).length;
      
      closeBlankQuiz();
    }

    function toggleRubricMode() {
      const mode = document.querySelector('input[name="rubric-mode"]:checked').value;
      if (mode === 'pdf') {
        document.getElementById('rubric-pdf-area').style.display = 'block';
        document.getElementById('rubric-text-area').style.display = 'none';
      } else {
        document.getElementById('rubric-pdf-area').style.display = 'none';
        document.getElementById('rubric-text-area').style.display = 'block';
      }
    }

    function updateExamQList() {
      const sub = document.getElementById('exam-subject').value; const sel = document.getElementById('exam-question-select'); sel.innerHTML = '<option value="">직접 입력하기</option>';
      db.questions.filter(q => q.subject === sub).forEach(q => { const opt = document.createElement('option'); opt.value = String(q.id); opt.textContent = `[추출] ${q.question.substring(0, 30)}...`; sel.appendChild(opt); });
      previewQuestion();
    }

    function previewQuestion() {
      const id = document.getElementById('exam-question-select').value;
      if (id) { const q = db.questions.find(x => String(x.id) === String(id)); if (q) document.getElementById('exam-direct-q').value = q.question; } 
      else { document.getElementById('exam-direct-q').value = ''; }
    }

    function toggleExamManager() {
      const view = document.getElementById('exam-manager-view'); view.classList.toggle('hidden');
      if(!view.classList.contains('hidden')) { document.getElementById('exam-edit-form').classList.add('hidden'); renderExamList(); }
    }

    function renderExamList() {
      const container = document.getElementById('exam-list'); const currentSubject = document.getElementById('exam-subject').value;
      const filtered = db.questions.filter(q => q.subject === currentSubject);
      if(filtered.length === 0) { container.innerHTML = '<p class="text-sm text-gray-400 py-4 text-center">이 과목에 추출된 문제가 없습니다.</p>'; return; }
      container.innerHTML = filtered.map(q => `
        <div class="p-3 bg-gray-50 border border-gray-200 rounded-lg hover:border-blue-300 transition-colors">
           <div class="flex justify-between items-start mb-2"><span class="text-[10px] text-blue-500 font-bold bg-blue-50 px-2 py-0.5 rounded">${q.subject}</span>
              <div class="flex gap-2"><button onclick="editExamQ('${q.id}')" class="px-2 py-1 bg-white border border-gray-200 text-xs font-bold text-slate-600 rounded hover:bg-gray-100">수정</button><button onclick="deleteExamQ('${q.id}')" class="px-2 py-1 border border-red-100 text-xs font-bold text-red-500 rounded hover:bg-red-50">삭제</button></div>
           </div>
           <p class="font-bold text-sm text-slate-800 mb-1 truncate">${q.question}</p>
           <p class="text-[11px] text-gray-500 truncate border-t border-gray-200 pt-1 mt-1">모범답안: ${q.rubric || '없음'}</p>
        </div>
      `).join('');
    }

    function deleteExamQ(id) { 
      customConfirm('문제를 삭제하시겠습니까?', () => {
        db.questions = db.questions.filter(q => String(q.id) !== String(id)); saveDB(); renderExamList(); updateExamQList(); showMsg("삭제되었습니다."); 
      });
    }

    function editExamQ(id) {
      const q = db.questions.find(x => String(x.id) === String(id)); if(!q) return; editingExamId = q.id;
      document.getElementById('edit-exam-subject').value = q.subject; document.getElementById('edit-exam-q').value = q.question; document.getElementById('edit-exam-rubric').value = q.rubric || '';
      document.getElementById('exam-edit-form').classList.remove('hidden');
    }

    function saveExamEdit() {
      if(!editingExamId) return;
      const idx = db.questions.findIndex(x => String(x.id) === String(editingExamId));
      if(idx > -1) { db.questions[idx].subject = document.getElementById('edit-exam-subject').value; db.questions[idx].question = document.getElementById('edit-exam-q').value.trim(); db.questions[idx].rubric = document.getElementById('edit-exam-rubric').value.trim(); saveDB(); }
      editingExamId = null; document.getElementById('exam-edit-form').classList.add('hidden'); renderExamList(); updateExamQList(); showMsg('문제가 성공적으로 수정되었습니다.');
    }

    function cancelExamEdit() { editingExamId = null; document.getElementById('exam-edit-form').classList.add('hidden'); }

    async function handleExamRubricUpload(e) {
      const file = e.target.files[0]; if(!file) return;
      document.getElementById('exam-rubric-name').innerHTML = `<i class="ri-check-line mr-1"></i>${file.name} 첨부완료`;
      try {
        const buf = await file.arrayBuffer(); const pdf = await pdfjsLib.getDocument(buf).promise; let text = '';
        for (let i=1; i<=pdf.numPages; i++) { const page = await pdf.getPage(i); const content = await page.getTextContent(); text += content.items.map(it => it.str).join(' ') + '\n'; }
        examState.uploadedRubricText = text;
      } catch(err) { showMsg("PDF 읽기 실패. 텍스트로 된 정상적인 PDF인지 확인해주세요."); }
    }

    function startExam() {
      const sub = document.getElementById('exam-subject').value;
      const qText = document.getElementById('exam-direct-q').value.trim();
      const time = parseInt(document.getElementById('exam-time').value);
      const id = document.getElementById('exam-question-select').value;
      
      let baseRubric = '';
      if (id) { const q = db.questions.find(x => String(x.id) === String(id)); if (q) baseRubric = q.rubric; }
      
      let combinedRubric = '';
      if (baseRubric) combinedRubric += `[기본 모범답안 및 배점]\n${baseRubric}\n\n`;
      
      let finalRubricInput = '';
      const rMode = document.querySelector('input[name="rubric-mode"]:checked').value;
      if (rMode === 'text') {
        finalRubricInput = document.getElementById('exam-rubric-text').value.trim();
      } else {
        finalRubricInput = examState.uploadedRubricText;
      }
      
      if (finalRubricInput) combinedRubric += `[강사 채점평 및 주의사항 (가장 중요하게 반영할 것)]\n${finalRubricInput}`;

      if (!qText) { showMsg("문제를 입력해주세요."); return; }

      if (examState.timer) clearInterval(examState.timer);
      examState = { subject: sub, question: qText, rubric: combinedRubric, time: time, seconds: time * 60, totalPage: Math.floor(time / 5), currPage: 1, answers: {}, timer: null, uploadedRubricText: examState.uploadedRubricText, isSubmitting: false };

      document.getElementById('room-subject').textContent = sub; document.getElementById('room-q-preview').textContent = qText;
      document.getElementById('room-q-full').textContent = qText; document.getElementById('room-total-page').textContent = examState.totalPage;
      document.getElementById('char-count').textContent = '0';
      document.getElementById('exam-setup').style.display = 'none'; document.getElementById('exam-room').style.display = 'block';

      renderAnswerSheet(); updateTimerDisplay();
      syncExamFullscreenButton();
      examState.timer = setInterval(() => {
        examState.seconds--; updateTimerDisplay();
        if (examState.seconds <= 0) { clearInterval(examState.timer); showMsg("⏰ 시간이 종료되었습니다! 자동 제출합니다."); performSubmitExam(); }
      }, 1000);
    }

    function updateTimerDisplay() {
      const m = Math.floor(examState.seconds / 60).toString().padStart(2, '0'); const s = (examState.seconds % 60).toString().padStart(2, '0');
      const el = document.getElementById('timer'); el.textContent = `${m}:${s}`;
      if (examState.seconds < 300) el.classList.add('text-rose-500'); else el.classList.remove('text-rose-500');
    }

    function renderAnswerSheet() {
      const container = document.getElementById('answer-lines'); container.innerHTML = '';
      for (let i = 1; i <= LINES_PER_PAGE; i++) {
        const key = `${examState.currPage}-${i}`; const savedVal = examState.answers[key] || '';
        const row = document.createElement('div'); row.className = 'answer-row';
        const numDiv = document.createElement('div'); numDiv.className = 'row-num'; numDiv.textContent = i;
        const wrapDiv = document.createElement('div'); wrapDiv.className = 'row-input-wrapper';
        const input = document.createElement('input'); input.type = 'text'; input.className = 'row-input'; input.maxLength = MAX_CHARS_PER_LINE; input.dataset.key = key; input.value = savedVal;
        const indicator = document.createElement('span'); indicator.className = 'char-indicator'; indicator.textContent = `${savedVal.length}/${MAX_CHARS_PER_LINE}`;
        wrapDiv.appendChild(input); wrapDiv.appendChild(indicator); row.appendChild(numDiv); row.appendChild(wrapDiv); container.appendChild(row);
      }
      document.getElementById('room-curr-page').textContent = examState.currPage;

      const inputs = container.querySelectorAll('.row-input');
      inputs.forEach((input, idx) => {
        input.addEventListener('input', (e) => {
          const val = e.target.value; examState.answers[e.target.dataset.key] = val;
          const ind = e.target.nextElementSibling; ind.textContent = `${val.length}/${MAX_CHARS_PER_LINE}`;
          if (val.length >= MAX_CHARS_PER_LINE) { ind.classList.add('full'); if (idx < inputs.length - 1) inputs[idx + 1].focus(); } else { ind.classList.remove('full'); }
          document.getElementById('char-count').textContent = Object.values(examState.answers).join('').length;
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (idx < inputs.length - 1) inputs[idx + 1].focus(); else changePage(1); } 
          else if (e.key === 'Backspace' && e.target.value === '' && idx > 0) { e.preventDefault(); inputs[idx - 1].focus(); } 
          else if (e.key === 'ArrowUp' && idx > 0) { e.preventDefault(); inputs[idx - 1].focus(); } 
          else if (e.key === 'ArrowDown' && idx < inputs.length - 1) { e.preventDefault(); inputs[idx + 1].focus(); }
        });
      });
      if (inputs.length > 0) inputs[0].focus();
    }

    function changePage(dir) {
      const next = examState.currPage + dir;
      if (next >= 1 && next <= examState.totalPage) { examState.currPage = next; renderAnswerSheet(); } else if (dir > 0) showMsg("마지막 페이지입니다."); else showMsg("첫 번째 페이지입니다.");
    }

    function submitExam(auto = false) {
      if (!auto) {
        customConfirm("제출하고 AI 채점을 진행하시겠습니까?", () => performSubmitExam());
      } else {
        performSubmitExam();
      }
    }

    async function performSubmitExam() {
      const submitBtn = document.getElementById('exam-submit-btn');

      await runAiButtonAction({
        button: submitBtn,
        overlayLoading: true,
        getBusy: () => examState.isSubmitting,
        setBusy: (v) => { examState.isSubmitting = v; },
        loadingLabel: (sec) =>
          sec < 8 ? 'AI 채점관이 답안을 분석 중입니다...' :
          sec < 16 ? '조금 더 걸리고 있습니다...' :
                     '응답을 기다리는 중입니다. 잠시만 기다려주세요.',
        execute: async () => {
          exitFullScreen();
          clearInterval(examState.timer);
          const fullAnswer = Object.keys(examState.answers).sort((a, b) => {
            const [ap, al] = a.split('-').map(Number); const [bp, bl] = b.split('-').map(Number); return ap !== bp ? ap - bp : al - bl;
          }).map(k => examState.answers[k]).filter(v => v.trim()).join('\n');
          const submitGroundingPack = gatherExamGroundingMaterials(examState.subject, examState.question, {
            userAnswer: fullAnswer,
            maxItems: 14,
            maxTextPerItem: 1400,
            maxTotalChars: 36000,
            debugGroundingLog: !!(typeof window !== 'undefined' && window.localStorage && window.localStorage.getItem('debug_grounding') === '1'),
          });
          const result = await gradeAnswerViaServer({
            subject: examState.subject,
            question: examState.question,
            rubric: examState.rubric,
            fullAnswer,
            materials: submitGroundingPack.materials,
          });
          return { result, fullAnswer };
        },
        isEmptyResult: (payload) => {
          const r = payload?.result;
          if (!r || typeof r !== 'object') return true;
          if (r.insufficientGrounding === true) return false;
          return typeof r.score !== 'number';
        },
        emptyFallback: '채점 결과를 받지 못했습니다. 잠시 후 다시 시도해주세요.',
        onSuccess: ({ result, fullAnswer }) => {
          result.details = result.details || {};
          result.details.issue = result.details.issue || 0;
          result.details.law = result.details.law || 0;
          result.details.logic = result.details.logic || 0;
          result.details.conclusion = result.details.conclusion || 0;
          result.details.format = result.details.format || 0;
          result.next3 = result.next3 || [];

          const record = {
            id: Date.now(),
            date: getToday(),
            subject: examState.subject,
            question: examState.question,
            rubric: examState.rubric,
            score: result.score,
            feedback: result,
            fullAnswer,
          };
          db.history.push(record);
          markStudiedToday('exam');
          saveDB();

          examState.uploadedRubricText = '';
          document.getElementById('exam-rubric-file').value = '';
          document.getElementById('exam-rubric-name').innerHTML = `<i class="ri-upload-cloud-2-line mr-1"></i>여기를 눌러 PDF 첨부`;
          document.getElementById('exam-rubric-text').value = '';

          document.getElementById('exam-room').style.display = 'none';
          document.getElementById('exam-setup').style.display = 'block';
          renderExamResult(record);
        },
        onError: (msg) => {
          showMsg(msg);
          document.getElementById('exam-room').style.display = 'none';
          document.getElementById('exam-setup').style.display = 'block';
        },
      });
    }

    function buildExamDimensionRows(fb) {
      const d = fb && fb.details ? fb.details : {};
      return EXAM_RUBRIC_DIMS.map((row) => {
        const val = Math.min(Math.max(Number(d[row.key]) || 0, 0), row.max);
        const ratio = row.max ? val / row.max : 1;
        return { ...row, val, ratio, weak: ratio < EXAM_WEAK_RATIO };
      });
    }

    function renderExamOutcomeSummary(data) {
      const fb = data.feedback || {};
      const dims = buildExamDimensionRows(fb);
      const weakDims = dims.filter((x) => x.weak);
      const strongCount = dims.length - weakDims.length;

      const sumScoreEl = document.getElementById('res-sum-score');
      if (sumScoreEl) sumScoreEl.textContent = typeof data.score === 'number' ? String(data.score) : '—';

      const dimTotalEl = document.getElementById('res-sum-dim-total');
      if (dimTotalEl) dimTotalEl.textContent = String(dims.length);

      const strongEl = document.getElementById('res-sum-strong-count');
      if (strongEl) strongEl.textContent = String(strongCount);
      const weakEl = document.getElementById('res-sum-weak-count');
      if (weakEl) weakEl.textContent = String(weakDims.length);

      const capEl = document.getElementById('res-sum-caption');
      if (capEl) {
        if (weakDims.length === 0) {
          capEl.textContent = '배점 항목만 보면 큰 허점은 적어 보입니다. 피드백·모범답안과 대조하여 결론·형식까지 다듬어 보세요.';
        } else {
          const labels = weakDims.map((x) => `「${x.label}」`).join(', ');
          capEl.textContent = `상대적으로 ${labels} 에서 추가 감점·보완 여지가 있습니다. 아래 가이드와 모범답안 영역을 함께 보세요.`;
        }
      }

      const rowsEl = document.getElementById('res-dimension-rows');
      if (rowsEl) {
        rowsEl.innerHTML = dims
          .map((row) => {
            const pct = Math.round(row.ratio * 100);
            const cls = row.weak ? 'border-rose-200 bg-rose-50/45' : 'border-emerald-100 bg-emerald-50/30';
            const badge = row.weak
              ? '<span class="text-[10px] font-extrabold text-rose-600 bg-white/90 px-1.5 py-0.5 rounded">보완</span>'
              : '<span class="text-[10px] font-extrabold text-emerald-600 bg-white/90 px-1.5 py-0.5 rounded">양호</span>';
            const barClr = row.weak ? 'bg-rose-400' : 'bg-emerald-400';
            return `<div class="flex flex-col sm:flex-row sm:items-center gap-2 p-2 md:p-2.5 rounded-xl border ${cls}">
              <div class="flex justify-between items-center gap-2 sm:w-52 shrink-0">
                <span class="text-[11px] md:text-xs font-bold text-slate-700">${escapeHtml(row.label)}</span>
                ${badge}
              </div>
              <div class="flex flex-1 items-center gap-2 min-w-0">
                <div class="flex-1 h-2 bg-white/80 rounded-full overflow-hidden border border-slate-100/80">
                  <div class="h-full ${barClr}" style="width:${pct}%"></div>
                </div>
                <span class="text-[11px] font-mono font-bold text-slate-600 w-[52px] text-right">${row.val}/${row.max}</span>
              </div>
            </div>`;
          })
          .join('');
      }

      const tipsWrap = document.getElementById('res-weak-tips');
      const tipsList = document.getElementById('res-weak-tips-list');
      if (tipsWrap && tipsList) {
        if (weakDims.length === 0) {
          tipsWrap.classList.add('hidden');
          tipsList.innerHTML = '';
        } else {
          tipsWrap.classList.remove('hidden');
          tipsList.innerHTML = weakDims.map((w) => `<li><span class="font-bold text-slate-800">${escapeHtml(w.label)}:</span> ${escapeHtml(w.tip)}</li>`).join('');
        }
      }
    }

    function scrollToExamSection(domId) {
      const el = document.getElementById(domId);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function retryFromLastExamResult() {
      if (!lastExamResultRecord) {
        showMsg('결과 정보가 없습니다. 대시보드의 최근 기록에서 「재도전」을 이용해 주세요.');
        return;
      }
      retryExam(lastExamResultRecord.id);
    }

    function saveLastExamWeaknessFlashcards() {
      if (!lastExamResultRecord) {
        showMsg('먼저 모의고사를 제출하여 결과를 확인해 주세요.');
        return;
      }
      const r = lastExamResultRecord;
      const fb = r.feedback || {};
      const dims = buildExamDimensionRows(fb);
      const weakLine = dims.filter((x) => x.weak).map((x) => `${x.label} ${x.val}/${x.max}`).join(', ') || '(배점 항목 균형)';

      const qPreview = String(r.question || '모의고사').trim().replace(/\s+/g, ' ');
      const front =
        `[모의고사 복습] ${String(r.subject || '').trim()}\n` +
        `${qPreview.slice(0, 220)}${qPreview.length > 220 ? '…' : ''}`;

      const parts = [`점수 ${typeof r.score === 'number' ? r.score : '미확정'}/100`, `보완 권장 배점: ${weakLine}`, ''];
      if ((fb.missing || '').trim()) parts.push('[부족한 점]\n' + fb.missing.trim());
      if (Array.isArray(fb.next3) && fb.next3.length) parts.push('[다음에 할 일]\n• ' + fb.next3.slice(0, 5).join('\n• '));

      let back = parts.join('\n').trim().slice(0, 3800);
      if (back.length < 24) back = `[요약 복습]\n${weakLine}`;

      db.flashcards.push({
        id: `${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
        subject: String(r.subject || '모의고사').trim(),
        front,
        back,
        repetition: 0,
        interval: 0,
        efactor: 2.5,
        nextReview: getLocalNow(),
      });
      saveDB();
      showMsg('복습 플래시카드를 추가했습니다. 플래시카드 탭에서 확인할 수 있습니다.');
    }

    async function explainLastExamDeductionWithAI() {
      if (!lastExamResultRecord) {
        showMsg('결과 정보를 찾을 수 없습니다.');
        return;
      }
      const btn = document.getElementById('res-ai-explain-btn');
      const out = document.getElementById('res-ai-explain-out');

      await runAiButtonAction({
        button: btn,
        getBusy: () => examResultAiExplainLoading,
        setBusy: (v) => {
          examResultAiExplainLoading = v;
        },
        loadingLabel: (sec) =>
          sec < 6
            ? 'AI가 채점 결과를 바탕으로 설명 중입니다…'
            : sec < 14
              ? '조금만 더 기다려 주세요…'
              : '응답 대기 중…',
        execute: async () => {
          const r = lastExamResultRecord;
          const fb = r.feedback || {};
          const d = fb.details || {};
          const qShort = String(r.question || '').trim().slice(0, 380);
          const backBits = [
            `총점 ${typeof r.score === 'number' ? r.score + '/100' : '미확정'}`,
            `세부: 쟁점 ${d.issue}/25, 법규 ${d.law}/30, 논리 ${d.logic}/25, 결론 ${d.conclusion}/10, 형식 ${d.format}/10`,
          ];
          if ((fb.good || '').trim()) backBits.push(`잘한 점: ${fb.good.trim().slice(0, 220)}`);
          if ((fb.missing || '').trim()) backBits.push(`부족한 점: ${fb.missing.trim().slice(0, 450)}`);
          if (Array.isArray(fb.next3) && fb.next3.length) backBits.push(`다음 조언: ${fb.next3.join(' / ')}`);
          if ((fb.advice || '').trim()) backBits.push(`조언: ${String(fb.advice).trim().slice(0, 200)}`);
          const res = await askAiTutorViaServer({
            subject: String(r.subject || '노무사').trim().slice(0, 100) || '노무사',
            front: (`모의고사 문제(발문 요지):\n${qShort}`).slice(0, 500),
            back: backBits.join('\n').slice(0, 998),
            question:
              '위는 내 모의고사 AI 채점 요약이다. 수험생 입장에서 감점이 예상되는 지점과, 우선 무엇을 어떻게 보완하면 좋은지 5~8문장으로 구체적으로 설명해 줘.',
          });
          return res;
        },
        isEmptyResult: (res) => !String(res?.answer || '').trim(),
        emptyFallback: '설명을 받지 못했습니다. 잠시 후 다시 시도해주세요.',
        onSuccess: (res) => {
          out.classList.remove('hidden');
          out.innerHTML = `<strong class="text-indigo-700 block mb-2"><i class="ri-sparkling-2-line"></i> AI 복습 가이드</strong><div>${escapeHtml(res.answer).replace(/\n/g, '<br>')}</div>`;
        },
        onError: (msg) => {
          out.classList.remove('hidden');
          out.innerHTML = `<span class="text-rose-600">${escapeHtml(msg)}</span>`;
        },
      });
    }

    function renderExamGradeGroundingRow(data) {
      const wrap = document.getElementById('res-grade-grounding-row');
      if (!wrap) return;
      const fb = data.feedback || {};
      const cites = Array.isArray(fb.citations) ? fb.citations : [];
      const hasNew =
        fb.insufficientGrounding === true ||
        typeof fb.groundingStrength === 'string' ||
        cites.length > 0;
      if (!hasNew) {
        wrap.classList.add('hidden');
        wrap.innerHTML = '';
        return;
      }

      wrap.classList.remove('hidden');

      let statusChip = '';
      if (fb.insufficientGrounding === true) {
        statusChip =
          '<span class="inline-block px-2 py-1 rounded-full text-[10px] font-extrabold bg-amber-100 text-amber-900">채점 근거 · 자료 부족</span>';
      } else if (fb.groundingStrength === 'partial') {
        statusChip =
          '<span class="inline-block px-2 py-1 rounded-full text-[10px] font-extrabold bg-amber-50 text-amber-800 border border-amber-200">채점 근거 · 부분 (인용 1건)</span>';
      } else {
        statusChip = `<span class="inline-block px-2 py-1 rounded-full text-[10px] font-extrabold bg-teal-100 text-teal-900">채점 근거 · 충분 (${cites.length}건 검증)</span>`;
      }

      let html = `<div class="flex flex-wrap gap-2 justify-center md:justify-start items-center">${statusChip}<span class="text-[10px] text-slate-500">저장 학습 자료 인용 문자열 검증 통과 분만 표시합니다.</span></div>`;

      if (fb.groundingReason && String(fb.groundingReason).trim()) {
        html += `<p class="text-[11px] text-amber-950 bg-amber-50 border border-amber-100 rounded-lg p-3 whitespace-pre-wrap leading-relaxed">${escapeHtml(fb.groundingReason)}</p>`;
      }
      if (fb.verdict && String(fb.verdict).trim()) {
        html += `<div><p class="text-[10px] font-bold text-slate-500 mb-1">판정 (자료+루브릭 반영 요약)</p><p class="text-[12px] text-slate-800 whitespace-pre-wrap leading-relaxed">${escapeHtml(String(fb.verdict)).replace(/\n/g, '<br>')}</p></div>`;
      }
      if (Array.isArray(fb.deductions) && fb.deductions.length) {
        html += `<div><p class="text-[10px] font-bold text-slate-500 mb-1">감점 포인트 후보</p><ul class="list-disc pl-4 text-[11px] text-slate-700 space-y-1">${fb.deductions.map((d) => `<li>${escapeHtml(String(d))}</li>`).join('')}</ul></div>`;
      }
      if (cites.length) {
        html += `<div><p class="text-[10px] font-bold text-slate-500 mb-2">채점 인용</p><ul class="space-y-2">`;
        cites.forEach((c) => {
          const title = escapeHtml(String(c.label || c.materialId || ''));
          const q = escapeHtml(String(c.quote || ''));
          html += `<li class="border border-slate-200 rounded-lg p-2.5 bg-white text-left shadow-sm"><div class="text-[10px] font-extrabold text-teal-700">${title}</div><blockquote class="text-[11px] border-l-4 border-teal-400 pl-2 my-1 text-slate-800 italic">${q}</blockquote></li>`;
        });
        html += '</ul></div>';
      }

      wrap.innerHTML = html;
    }

    function getExamGroundingFollowUpMode(data) {
      const fb = data.feedback || {};
      if (fb.insufficientGrounding === true) return 'insufficient';
      if (fb.groundingStrength === 'partial') return 'partial';
      if (fb.groundingStrength === 'full') return 'full';
      return 'legacy';
    }

    function openGroundingMaterialsDetailsUsed() {
      const det = document.getElementById('res-grounding-materials-details');
      if (det) {
        try {
          det.open = true;
        } catch (e) {
          det.setAttribute('open', 'open');
        }
        det.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else showMsg('자료 목록 영역을 찾지 못했습니다.');
    }

    function focusGroundedExplainButton() {
      const card = document.getElementById('res-grounded-explain-card');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const btn = document.getElementById('res-grounded-explain-btn');
      if (btn) setTimeout(() => btn.focus(), 400);
    }

    async function groundedExplainOnlyFromActions() {
      focusGroundedExplainButton();
      await runGroundedExamExplain();
    }

    function navigateGroundingRelatedAdd() {
      showMsg('카드 작성 화면으로 이동합니다. 과목만 맞춰도 검색 매칭이 좋아집니다.');
      navigate('flashcard');
      setTimeout(() => toggleManualCardForm(), 260);
    }

    function openGroundingRelatedMaterialsHub() {
      openGroundingMaterialsDetailsUsed();
      showMsg(
        '위 목록이 이번에 선별된 자료입니다. 부족하면 플래시카드·개요 탭으로 이동해 같은 과목의 노트를 더 쌓은 뒤 재채점해 보세요.',
      );
    }

    async function retryGroundedRegradeSameAnswer() {
      if (retryGroundedRegradeLoading) return;
      const rec = lastExamResultRecord;
      if (!rec || !rec.question) {
        showMsg('결과 또는 발문 정보가 없습니다.');
        return;
      }
      retryGroundedRegradeLoading = true;
      showLoading('근거 자료를 다시 선별하고 채점합니다…');
      try {
        const fa = String(rec.fullAnswer || '');
        const pack = gatherExamGroundingMaterials(rec.subject, rec.question, {
          userAnswer: fa,
          maxItems: 14,
          maxTextPerItem: 1400,
          maxTotalChars: 36000,
          debugGroundingLog:
            typeof localStorage !== 'undefined' && localStorage.getItem('debug_grounding') === '1',
        });
        lastExamGroundingPack = pack;
        updateExamGroundingPanelFromPack();

        const result = await gradeAnswerViaServer({
          subject: rec.subject,
          question: rec.question,
          rubric: rec.rubric,
          fullAnswer: fa,
          materials: pack.materials,
        });

        result.details = result.details || {};
        result.details.issue = result.details.issue || 0;
        result.details.law = result.details.law || 0;
        result.details.logic = result.details.logic || 0;
        result.details.conclusion = result.details.conclusion || 0;
        result.details.format = result.details.format || 0;
        result.next3 = result.next3 || [];

        rec.score = result.score;
        rec.feedback = result;
        const idx = db.history.findIndex((h) => String(h.id) === String(rec.id));
        if (idx > -1) db.history[idx] = rec;
        saveDB();
        renderExamResult(rec);
        if (result.insufficientGrounding === true || typeof result.score !== 'number') {
          showMsg('아직 근거가 부족하거나 인용 검증에 실패했습니다. 카드·개요를 더 쌓고 다시 시도해 보세요.');
        } else showMsg('자료 선별 로직으로 다시 채점했습니다.');
      } catch (e) {
        showMsg(String(e?.message || '재채점 요청에 실패했습니다.'));
      } finally {
        retryGroundedRegradeLoading = false;
        hideLoading();
      }
    }

    function renderExamGroundingFollowUpActions(data) {
      const bannerEl = document.getElementById('res-grounding-action-banner');
      const btnWrap = document.getElementById('res-grounding-action-buttons');
      if (!bannerEl || !btnWrap) return;

      const mode = getExamGroundingFollowUpMode(data);
      const fb = data.feedback || {};
      const pack = lastExamGroundingPack;
      const nMat = pack && Array.isArray(pack.materials) ? pack.materials.length : 0;

      function actBtn(surface, onc, htmlInner) {
        return `<button type="button" onclick="${onc}" class="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-[11px] font-extrabold shadow-sm transition-all active:scale-[0.98] ${surface}">${htmlInner}</button>`;
      }

      if (mode === 'legacy') {
        bannerEl.classList.add('hidden');
        bannerEl.innerHTML = '';
        btnWrap.classList.remove('hidden');
        btnWrap.innerHTML = [
          actBtn(
            'bg-slate-800 hover:bg-slate-900 text-white',
            'retryGroundedRegradeSameAnswer()',
            '<i class="ri-refresh-line"></i> 자료 재선별·재채점',
          ),
          actBtn(
            'bg-white border border-teal-200 text-teal-800 hover:bg-teal-50',
            'openGroundingMaterialsDetailsUsed()',
            '<i class="ri-folder-open-line"></i> 선별 자료 보기',
          ),
          actBtn(
            'bg-teal-600 hover:bg-teal-700 text-white',
            'focusGroundedExplainButton()',
            '<i class="ri-shield-check-line"></i> 자료 해설 받기',
          ),
          actBtn(
            'bg-emerald-600 hover:bg-emerald-700 text-white',
            'saveLastExamWeaknessFlashcards()',
            '<i class="ri-stack-line"></i> 복습 카드 만들기',
          ),
        ].join('');
        return;
      }

      let bannerInner = '';
      let buttonsHtml = '';

      if (mode === 'insufficient') {
        const subTip = !nMat
          ? '원인 분류 · 선택된 학습 근거 조각이 없거나 너무 적었을 수 있습니다.'
          : '원인 분류 · 조각은 있었으나 채택 인용이 자료 원문과 정확히 일치하지 않았을 수 있습니다.';
        bannerInner = `
          <div class="border-l-4 border-amber-500 pl-3">
            <p class="text-sm font-extrabold text-amber-950 mb-1">점수 미확정</p>
            <p class="text-[11px] text-amber-950/95 leading-relaxed">${escapeHtml(
              fb.groundingReason ||
                '저장된 학습 자료에서 채점에 필요한 유효 인용을 확인하지 못했습니다.',
            )}</p>
            <p class="text-[10px] font-bold text-amber-800/90 mt-2">${escapeHtml(subTip)}</p>
          </div>`;
        buttonsHtml = [
          actBtn(
            'bg-amber-700 hover:bg-amber-800 text-white',
            'navigateGroundingRelatedAdd()',
            '<i class="ri-add-circle-line"></i> 관련 학습 자료 추가',
          ),
          actBtn(
            'bg-white border border-amber-300 text-amber-900 hover:bg-amber-50',
            'retryGroundedRegradeSameAnswer()',
            '<i class="ri-refresh-line"></i> 자료 다시 모아 재채점',
          ),
          actBtn(
            'bg-teal-600 hover:bg-teal-700 text-white',
            'groundedExplainOnlyFromActions()',
            '<i class="ri-chat-check-line"></i> 점수 없이 해설만',
          ),
        ].join('');
      } else if (mode === 'partial') {
        bannerInner = `
          <div class="border-l-4 border-amber-400 pl-3">
            <p class="text-sm font-extrabold text-amber-950 mb-1">부분 근거 채점</p>
            <p class="text-[11px] text-amber-950/95 leading-relaxed">
              확인된 학습 자료 근거가 1건에 머물러 참고 채점에 가깝습니다. 카드·목차 등을 더 쌓으면 안정적인 인용 검증 후 재채점이 가능합니다.
            </p>
          </div>`;
        buttonsHtml = [
          actBtn(
            'bg-slate-800 hover:bg-slate-900 text-white',
            'retryGroundedRegradeSameAnswer()',
            '<i class="ri-refresh-line"></i> 근거 보강 후 재채점',
          ),
          actBtn(
            'bg-white border border-slate-200 text-slate-800 hover:bg-slate-50',
            'openGroundingMaterialsDetailsUsed()',
            '<i class="ri-file-list-line"></i> 사용된 자료 펼치기',
          ),
          actBtn(
            'bg-teal-50 border border-teal-300 text-teal-900 hover:bg-teal-100',
            'openGroundingRelatedMaterialsHub()',
            '<i class="ri-links-line"></i> 관련 자료·안내',
          ),
        ].join('');
      } else {
        bannerInner = `
          <div class="border-l-4 border-teal-500 pl-3">
            <p class="text-sm font-extrabold text-teal-950 mb-1">자료 근거가 충분히 확보됨</p>
            <p class="text-[11px] text-teal-950/95 leading-relaxed">
              저장 학습 조각 인용 검증을 통과한 근거로 채점·피드백을 구성했습니다. 아래에서 인용 근거를 다시 확인하거나 해설·복습으로 이어갈 수 있습니다.
            </p>
          </div>`;
        buttonsHtml = [
          actBtn(
            'bg-white border border-teal-200 text-teal-900 hover:bg-teal-50',
            'openGroundingMaterialsDetailsUsed()',
            '<i class="ri-folder-open-line"></i> 사용된 자료 보기',
          ),
          actBtn(
            'bg-teal-600 hover:bg-teal-700 text-white',
            'focusGroundedExplainButton()',
            '<i class="ri-shield-check-line"></i> 자료 기반 해설',
          ),
          actBtn(
            'bg-emerald-600 hover:bg-emerald-700 text-white',
            'saveLastExamWeaknessFlashcards()',
            '<i class="ri-stack-line"></i> 복습 카드 만들기',
          ),
        ].join('');
      }

      bannerEl.classList.remove('hidden');
      bannerEl.innerHTML = bannerInner;
      btnWrap.classList.remove('hidden');
      btnWrap.innerHTML = buttonsHtml;
    }

    function coerceExamScore(s) {
      if (s === null || s === undefined || s === '') return NaN;
      const n = Number(s);
      return Number.isFinite(n) ? n : NaN;
    }

    function normalizeExamFeedback(fbRaw, dataScore) {
      const fb =
        fbRaw && typeof fbRaw === 'object' && !Array.isArray(fbRaw) ? { ...fbRaw } : {};
      const finite = coerceExamScore(dataScore);
      if (typeof fb.groundingReasonType !== 'string') {
        if (Number.isFinite(finite)) fb.groundingReasonType = 'legacy_ungrounded';
        else if (fb.insufficientGrounding === true) fb.groundingReasonType = 'no_materials_provided';
        else fb.groundingReasonType = 'quote_validation_failed';
      }
      return fb;
    }

    /** 결과 카드 CTA 순서는 groundingReasonType 기준 (explain API와 같은 enum 이름) */
    const EXAM_GROUNDING_CTA_ORDER = {
      no_materials_provided: ['add-materials', 'materials-hub', 'explain-only'],
      no_relevant_materials_selected: ['materials-hub', 'regrade', 'explain-only'],
      model_returned_no_citations: ['regrade', 'explain-only', 'materials-hub'],
      quote_validation_failed: ['used-materials', 'regrade', 'explain-only'],
      only_one_valid_citation: ['regrade', 'used-materials', 'materials-hub'],
      limited_material_coverage: ['regrade', 'used-materials', 'materials-hub'],
      sufficient_valid_citations: ['used-materials', 'explain-only', 'add-materials'],
      legacy_ungrounded: ['materials-hub', 'explain-only', 'regrade'],
    };

    const EXAM_GROUNDING_CTA_LABELS = {
      'add-materials': '관련 학습 카드 만들기',
      'materials-hub': '카드 목록으로',
      'regrade': '같은 설정으로 다시 채점',
      'used-materials': '사용된 근거 인용 보기',
      'explain-only': '자료 기반 해설',
    };

    let __examResultContextRecord = null;

    function getExamGroundingBannerContent(fb, dataScore) {
      const type = fb && fb.groundingReasonType;
      if (!type || type === 'legacy_ungrounded') return null;
      const finiteSc = coerceExamScore(dataScore);
      const insufficient =
        fb.insufficientGrounding === true || fb.score === null || !Number.isFinite(finiteSc);
      if (insufficient && type !== 'legacy_ungrounded') {
        const map = {
          no_materials_provided: { title: '점수 미확정', subtitle: '제출된 학습 자료가 없거나 비었습니다. 같은 과목의 플래시카드를 쌓은 뒤 다시 채점해 보세요.' },
          no_relevant_materials_selected: { title: '점수 미확정', subtitle: '보낸 자료 중 본문이 있는 카드를 찾지 못했습니다. 카드 앞면·뒷면 내용을 확인해 주세요.' },
          model_returned_no_citations: { title: '점수 미확정', subtitle: '모델이 자료 인용을 내지 않았습니다. 잠시 후 다시 채점하거나 자료를 보강해 보세요.' },
          quote_validation_failed: { title: '점수 미확정', subtitle: '인용문이 자료 본문과 맞지 않아 근거로 쓸 수 없었습니다.' },
        };
        const spec = map[type];
        const fallback = fb.groundingReason && String(fb.groundingReason).trim();
        return { variant: 'warning', title: spec ? spec.title : '점수 미확정', subtitle: spec ? spec.subtitle : (fallback || '저장된 자료만으로 점수를 확정하지 못했습니다.') };
      }
      if (type === 'sufficient_valid_citations') {
        return { variant: 'ok', title: '자료 기반 채점', subtitle: '선택된 학습 자료에서 근거가 충분히 확인되어 점수를 확정했습니다.' };
      }
      if (type === 'only_one_valid_citation' || type === 'limited_material_coverage') {
        return {
          variant: 'partial',
          title: '부분 근거 채점',
          subtitle: type === 'limited_material_coverage'
            ? '보낸 학습 출처가 적어 근거가 제한적입니다. 카드를 더 쌓으면 재채점 품질이 좋아집니다.'
            : '유효한 자료 인용이 한 건뿐이라 보수적으로 채점했습니다.',
        };
      }
      return { variant: 'partial', title: '자료 연계 채점', subtitle: (fb.groundingReason && String(fb.groundingReason).trim()) || '학습 자료와 연계해 채점했습니다.' };
    }

    function applyExamGroundingBanner(fb, dataScore) {
      const el = document.getElementById('res-grounding-banner');
      if (!el) return;
      const row = getExamGroundingBannerContent(fb, dataScore);
      if (!row && !(fb && fb.groundingReasonType === 'legacy_ungrounded')) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
      }
      if (!row && fb && fb.groundingReasonType === 'legacy_ungrounded') {
        el.classList.remove('hidden');
        el.className = 'max-w-xl mx-auto mb-4 rounded-xl border border-slate-200 bg-white px-4 py-3 text-left leading-relaxed text-[12px] md:text-[13px] text-slate-700';
        el.innerHTML = '<div class="font-extrabold tracking-tight text-slate-800">모범답안 중심 채점</div><p class="mt-1 opacity-90">학습 카드 근거는 사용하지 않았습니다. 카드와 함께 보내면 자료 기반 채점·해설을 쓸 수 있습니다.</p>';
        return;
      }
      el.classList.remove('hidden');
      const styles =
        row.variant === 'warning'
          ? 'border-amber-200 bg-amber-50/90 text-amber-950'
          : row.variant === 'partial'
            ? 'border-amber-300 bg-white text-slate-800'
            : 'border-emerald-200 bg-emerald-50/50 text-emerald-950';
      el.className =
        `max-w-xl mx-auto mb-4 rounded-xl border px-4 py-3 text-left leading-relaxed text-[12px] md:text-[13px] ${styles}`.trim();
      el.innerHTML = `<div class="font-extrabold tracking-tight">${row.title}</div><p class="mt-1 opacity-95">${row.subtitle}</p>`;
    }

    function updateExamGroundingDebugStrip(fb) {
      const el = document.getElementById('res-grounding-debug');
      if (!el) return;
      if (typeof localStorage !== 'undefined' && localStorage.getItem('debug_grounding') === '1') {
        const cite = fb && Array.isArray(fb.citations) ? fb.citations.length : 0;
        const mat = fb && fb.groundingMetrics && typeof fb.groundingMetrics.materialsSent === 'number' ? fb.groundingMetrics.materialsSent : '?';
        el.classList.remove('hidden');
        el.textContent =
          `[grounding] type=${fb && fb.groundingReasonType}` +
          ` strength=${fb && fb.groundingStrength}` +
          ` insufficient=${fb && fb.insufficientGrounding}` +
          ` citations=${cite}` +
          ` materials±${mat}`;
      } else {
        el.classList.add('hidden');
        el.textContent = '';
      }
    }

    function renderExamGroundingCtas(fb) {
      const wrap = document.getElementById('res-grounding-actions');
      if (!wrap) return;
      const gt = fb && fb.groundingReasonType;
      if (!gt || !EXAM_GROUNDING_CTA_ORDER[gt]) {
        wrap.classList.add('hidden');
        wrap.innerHTML = '';
        return;
      }
      const order = EXAM_GROUNDING_CTA_ORDER[gt];
      const citeLen = fb && Array.isArray(fb.citations) ? fb.citations.length : 0;
      const parts = [];
      order.forEach((key, idx) => {
        if (key === 'used-materials' && citeLen === 0 && gt !== 'quote_validation_failed') return;
        const label = EXAM_GROUNDING_CTA_LABELS[key] || key;
        const primary = idx === 0 ? ' bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600' : ' bg-white hover:bg-slate-50 text-slate-700 border-slate-200';
        parts.push(
          `<button type="button" onclick="examGroundingCta('${key}')" class="px-3 py-2 rounded-lg text-[11px] md:text-xs font-bold border shadow-sm transition-all active:scale-95${primary}">${escapeHtml(label)}</button>`,
        );
      });
      if (parts.length === 0) {
        wrap.classList.add('hidden');
        wrap.innerHTML = '';
        return;
      }
      wrap.classList.remove('hidden');
      wrap.innerHTML = parts.join('');
    }

    function renderExamGroundingUsedBlock(fb) {
      const wrap = document.getElementById('res-grounding-used-wrap');
      const body = document.getElementById('res-grounding-used-body');
      if (!wrap || !body) return;
      const cites = fb && Array.isArray(fb.citations) ? fb.citations : [];
      if (cites.length === 0) {
        wrap.classList.add('hidden');
        body.textContent = '';
        return;
      }
      wrap.classList.remove('hidden');
      body.innerHTML = cites
        .map(
          (c, i) =>
            `<div class="p-2 rounded-lg bg-white border border-slate-100 text-left"><span class="text-[10px] font-bold text-slate-400">#${i + 1} ${escapeHtml(c.label || c.materialId || '')}</span><blockquote class="mt-1 pl-2 border-l-2 border-emerald-300 whitespace-pre-wrap">${escapeHtml(c.quote || '')}</blockquote></div>`,
        )
        .join('');
    }

    function scrollToExamUsedMaterials() {
      const wrap = document.getElementById('res-grounding-used-wrap');
      const det = document.getElementById('res-grounding-used-details');
      if (det) det.open = true;
      if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    async function examGroundingCta(key) {
      const rec = __examResultContextRecord;
      if (!rec) return;
      if (key === 'materials-hub') {
        navigate('flashcard');
        return;
      }
      if (key === 'add-materials') {
        navigate('flashcard');
        document.getElementById('fc-manager-view')?.classList.add('hidden');
        document.getElementById('csv-upload-form')?.classList.add('hidden');
        document.getElementById('manual-card-form')?.classList.remove('hidden');
        return;
      }
      if (key === 'regrade') {
        retryExam(rec.id);
        return;
      }
      if (key === 'used-materials') {
        const cites = __examResultContextRecord && __examResultContextRecord.feedback && __examResultContextRecord.feedback.citations;
        if (Array.isArray(cites) && cites.length > 0) scrollToExamUsedMaterials();
        else document.getElementById('res-rubric')?.closest('.neo-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
      if (key === 'explain-only') {
        const materials = collectExamMaterialsFromDb(rec.subject);
        if (materials.length === 0) {
          showMsg('과목에 저장된 카드가 없어 자료 기반 해설을 요청할 수 없습니다.');
          return;
        }
        showLoading('자료 기반 해설 작성 중…');
        try {
          const rubricExcerpt = String(rec.rubric || '').slice(0, 16000);
          const ex = await examGroundedExplainViaServer({
            subject: rec.subject,
            question: rec.question,
            userAnswer: rec.fullAnswer || '',
            rubricExcerpt,
            materials,
          });
          customConfirm(
            `<div class="text-left text-sm space-y-2"><div class="font-bold text-emerald-700">${ex.groundingReasonType || ''} · ${escapeHtml(ex.groundingStrength || '')}</div><div>${escapeHtml(ex.verdict || ex.insufficientReason || '')}</div><div class="text-slate-600 whitespace-pre-wrap">${escapeHtml(ex.explanation || '')}</div></div>`,
            () => {},
          );
        } catch (e) {
          showMsg(e.message);
        } finally {
          hideLoading();
        }
      }
    }

    function renderExamResult(data) {
      __examResultContextRecord = data;
      lastExamResultRecord = data;

      const explainOut = document.getElementById('res-ai-explain-out');
      if (explainOut) {
        explainOut.classList.add('hidden');
        explainOut.innerHTML = '';
      }

      lastExamGroundingPack = gatherExamGroundingMaterials(data.subject, data.question, {
        userAnswer: data.fullAnswer || '',
        maxItems: 14,
        maxTextPerItem: 1400,
        maxTotalChars: 36000,
        debugGroundingLog: !!(typeof window !== 'undefined' && window.localStorage && window.localStorage.getItem('debug_grounding') === '1'),
      });
      updateExamGroundingPanelFromPack();
      const groundedPanel = document.getElementById('res-grounded-explain-panel');
      if (groundedPanel) {
        groundedPanel.classList.add('hidden');
        groundedPanel.innerHTML = '';
      }

      const fb = normalizeExamFeedback(data.feedback, data.score);
      data.feedback = fb;
      fb.groundingMetrics = { materialsSent: collectExamMaterialsFromDb(data.subject).length };

      if (typeof localStorage !== 'undefined' && localStorage.getItem('debug_grounding') === '1')
        console.log('[exam grounding]', fb.groundingReasonType, fb.groundingStrength, 'score=', data.score);

      let trendHtml = '';
      if (data.question && typeof data.score === 'number') {
         const attempts = db.history.filter(h => h.question === data.question).sort((a,b) => a.id - b.id);
         const currIdx = attempts.findIndex(h => h.id === data.id);
         if (currIdx > 0) {
            const prevScore = attempts[currIdx - 1].score;
            const currNum = coerceExamScore(data.score);
            const prevNum = coerceExamScore(prevScore);
            if (Number.isFinite(currNum) && Number.isFinite(prevNum)) {
              const diff = currNum - prevNum;
              if (diff > 0) trendHtml = `<div class="bg-emerald-100 text-emerald-700 px-3 py-1 rounded-full text-[11px] font-extrabold mt-2 tracking-wide animate-pulse">▲ 이전 대비 ${diff}점 상승!</div>`;
              else if (diff < 0) trendHtml = `<div class="bg-rose-100 text-rose-700 px-3 py-1 rounded-full text-[11px] font-extrabold mt-2 tracking-wide">▼ 이전 대비 ${Math.abs(diff)}점 하락</div>`;
              else trendHtml = `<div class="bg-gray-100 text-gray-500 px-3 py-1 rounded-full text-[11px] font-extrabold mt-2 tracking-wide">- 이전 점수와 동일</div>`;
            }
         }
      }

      const scoreEl = document.getElementById('res-score');
      const scoreNum = coerceExamScore(data.score);
      if (fb.insufficientGrounding === true || !Number.isFinite(scoreNum)) {
        scoreEl.className =
          'text-4xl md:text-6xl font-black text-amber-600 flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2';
        scoreEl.innerHTML = '<span>미확정</span><span class="text-base md:text-lg font-bold text-slate-500">근거 확인 필요</span>';
      } else {
        scoreEl.className = 'text-5xl md:text-7xl font-black text-emerald-500 flex items-center justify-center';
        scoreEl.innerHTML = `${Math.round(scoreNum)}<span class="text-xl md:text-2xl text-gray-300 ml-1">점</span>`;
      }

      applyExamGroundingBanner(fb, data.score);
      updateExamGroundingDebugStrip(fb);
      renderExamGroundingUsedBlock(fb);
      renderExamGroundingCtas(fb);

      let scoreBox = document.getElementById('res-score').parentNode;
      let existingBadge = document.getElementById('score-trend-badge');
      if(existingBadge) existingBadge.remove(); 
      
      if(trendHtml) {
          scoreBox.insertAdjacentHTML('beforeend', `<div id="score-trend-badge">${trendHtml}</div>`);
      }

      document.getElementById('res-feedback').textContent = fb.insufficientGrounding === true
        ? (fb.groundingReason || '저장된 학습 자료에서 채점에 필요한 유효 인용을 확보하지 못했습니다.')
        : (fb.feedback || fb.groundingReason || '');
      renderExamGradeGroundingRow(data);
      renderExamGroundingFollowUpActions(data);

      const det = fb.details || {};
      const setBar = (id, val, max) => { const safeVal = Math.min(Math.max(val || 0, 0), max); document.getElementById(`score-${id}`).textContent = safeVal; document.getElementById(`bar-${id}`).style.width = `${(safeVal / max) * 100}%`; };
      setBar('issue', det.issue, 25); setBar('law', det.law, 30); setBar('logic', det.logic, 25); setBar('conc', det.conclusion, 10); setBar('form', det.format, 10);

      document.getElementById('res-good').textContent = fb.good || ''; document.getElementById('res-miss').textContent = fb.missing || ''; document.getElementById('res-next').innerHTML = (fb.next3 || []).map(t => `<li>${t}</li>`).join('');
      renderExamOutcomeSummary(data);
      
      const myAnswerEl = document.getElementById('res-my-answer');
      if (myAnswerEl) myAnswerEl.textContent = data.fullAnswer || '저장된 답안이 없습니다.';
      
      const rubricEl = document.getElementById('res-rubric');
      if (rubricEl) {
         let rawRubric = data.rubric || '저장된 모범답안이 없습니다.';
         rawRubric = rawRubric.replace(/\[기본 모범답안 및 배점\]/g, '').replace(/\[강사 채점평 및 주의사항.*?\]/g, '\n[강사 채점평/주의사항]');
         rubricEl.textContent = rawRubric.trim();
      }

      navigate('result');
    }

    function exportDB() { const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `nomusa_backup_${getToday()}.json`; a.click(); showMsg("✅ 백업 파일이 다운로드되었습니다."); }
    function importDB() { document.getElementById('import-file-input').click(); }
    
    function getAppDB() { return db; }
    function setAppDB(newDB) { db = { ...db, ...newDB }; }

    function doImportDB(event) {
      const file = event.target.files[0]; if (!file) return; const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const imported = JSON.parse(e.target.result);
          if (!imported.history || !imported.flashcards) { showMsg("❌ 올바른 백업 파일이 아닙니다."); return; }
          customConfirm("백업 데이터를 복구하시겠습니까?<br>(현재 데이터는 덮어씌워집니다)", () => {
            setAppDB(imported); saveDB(); renderDashboard(); showMsg("✅ 데이터가 복구되었습니다!");
          });
        } catch(err) { showMsg("❌ 파일 파싱 오류: " + err.message); }
      };
      reader.readAsText(file); event.target.value = '';
    }
    
    function resetDB() { 
      customConfirm("정말로 모든 학습 기록을 삭제하시겠습니까?<br>이 작업은 되돌릴 수 없습니다!", () => {
        localStorage.removeItem('nomusa_db_v4'); location.reload(); 
      });
    }
    
    window.customConfirm = customConfirm;
    window.navigate = navigate;
    window.examGroundingCta = examGroundingCta;
    window.toggleCsvUploadForm = toggleCsvUploadForm;
    window.cancelCsvUpload = cancelCsvUpload;
    window.processCsvUpload = processCsvUpload;
    window.toggleFcManager = toggleFcManager;
    window.toggleManualCardForm = toggleManualCardForm;
    window.cancelManualFlashcard = cancelManualFlashcard;
    window.addManualFlashcard = addManualFlashcard;
    window.renderFcList = renderFcList;
    window.toggleSelectAllFc = toggleSelectAllFc;
    window.updateSelectAllFcState = updateSelectAllFcState;
    window.removeBracketsFromSelected = removeBracketsFromSelected;
    window.deleteSelectedFc = deleteSelectedFc;
    window.editFc = editFc;
    window.deleteFc = deleteFc;
    window.flipCard = flipCard;
    window.checkFcClozeAnswers = checkFcClozeAnswers;
    window.rateCard = rateCard;
    window.getFcHint = getFcHint;
    window.getFcMnemonic = getFcMnemonic;
    window.setFcActiveInput = setFcActiveInput;
    window.fillFcWordChip = fillFcWordChip;
    window.askAITutor = askAITutor;
    
    window.renderOutlineList = renderOutlineList;
    window.toggleOutlineAdder = toggleOutlineAdder;
    window.cancelOutlineEdit = cancelOutlineEdit;
    window.saveOutline = saveOutline;
    window.editOutline = editOutline;
    window.deleteOutline = deleteOutline;
    window.startBlankQuiz = startBlankQuiz;
    window.closeBlankQuiz = closeBlankQuiz;
    window.generateBlankQuiz = generateBlankQuiz;
    window.checkBlankAnswers = checkBlankAnswers;
    window.rateOutline = rateOutline;
    window.generateOutlineWithAI = generateOutlineWithAI;
    window.fillWordChipOutline = fillWordChipOutline;
    window.generateParagraphFromOutline = generateParagraphFromOutline;

    window.updateExamQList = updateExamQList;
    window.previewQuestion = previewQuestion;
    window.toggleExamManager = toggleExamManager;
    window.editExamQ = editExamQ;
    window.deleteExamQ = deleteExamQ;
    window.saveExamEdit = saveExamEdit;
    window.cancelExamEdit = cancelExamEdit;
    window.handleExamRubricUpload = handleExamRubricUpload;
    window.startExam = startExam;
    wireExamFullscreenControls();
    window.submitExam = submitExam;
    window.performSubmitExam = performSubmitExam;
    window.changePage = changePage;
    window.retryExam = retryExam;
    window.scrollToExamSection = scrollToExamSection;
    window.retryFromLastExamResult = retryFromLastExamResult;
    window.saveLastExamWeaknessFlashcards = saveLastExamWeaknessFlashcards;
    window.explainLastExamDeductionWithAI = explainLastExamDeductionWithAI;
    window.runGroundedExamExplain = runGroundedExamExplain;
    window.retryGroundedRegradeSameAnswer = retryGroundedRegradeSameAnswer;
    window.navigateGroundingRelatedAdd = navigateGroundingRelatedAdd;
    window.openGroundingMaterialsDetailsUsed = openGroundingMaterialsDetailsUsed;
    window.openGroundingRelatedMaterialsHub = openGroundingRelatedMaterialsHub;
    window.focusGroundedExplainButton = focusGroundedExplainButton;
    window.groundedExplainOnlyFromActions = groundedExplainOnlyFromActions;
    window.toggleRubricMode = toggleRubricMode;
    window.renderHistoryTable = renderHistoryTable;

    window.searchLawDB = searchLawDB;
    window.compareConceptsWithAI = compareConceptsWithAI;
    window.processAIConvert = processAIConvert;
    window.handleFileDisplay = handleFileDisplay;
    window.toggleInputMode = toggleInputMode;
    window.cancelConvert = cancelConvert;
    window.saveConvertedData = saveConvertedData;
    window.removePreviewItem = removePreviewItem;
    
    window.exportDB = exportDB;
    window.importDB = importDB;
    window.doImportDB = doImportDB;
    window.resetDB = resetDB;
    
    window.getAppDB = getAppDB;
    window.setAppDB = setAppDB;

    window.viewHistory = viewHistory;
    window.analyzeStudyHistory = analyzeStudyHistory;
    window.renderDashboard = renderDashboard;
    window.renderDueFlashcards = renderDueFlashcards;

