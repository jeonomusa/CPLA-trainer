    import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
    import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
    import { getFirestore, doc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

    const firebaseConfig = {
      apiKey: "AIzaSyAkAfhZev3uF9qzAcqfhwBrKWorV10qNWE",
      authDomain: "nomusa-trainer.firebaseapp.com",
      projectId: "nomusa-trainer",
      storageBucket: "nomusa-trainer.firebasestorage.app",
      messagingSenderId: "361338496072",
      appId: "1:361338496072:web:798c1a6695cbfab5a7647d"
    };

    try {
      const app = initializeApp(firebaseConfig);
      const auth = getAuth(app);
      const firestore = getFirestore(app);
      let unsubSnapshot = null;

      window.loginWithGoogle = () => {
        const provider = new GoogleAuthProvider();
        signInWithPopup(auth, provider).catch(error => {
          console.error("Login Error:", error);
          alert("로그인 중 오류가 발생했습니다: " + error.message);
        });
      };

      window.logoutGoogle = () => { signOut(auth).then(() => { alert("로그아웃 되었습니다."); }); };

      onAuthStateChanged(auth, (user) => {
        window.currentUser = user;
        const statusEl = document.getElementById('auth-status'); 
        const headerStatus = document.getElementById('header-auth-status');
        const loginBtn = document.getElementById('login-btn'); 
        const logoutBtn = document.getElementById('logout-btn');

        if (user) {
          if (statusEl) statusEl.textContent = user.displayName + " (연동됨)"; 
          if (headerStatus) { headerStatus.textContent = "Cloud Sync: ON"; headerStatus.classList.replace('text-slate-400', 'text-blue-400'); }
          if (loginBtn) loginBtn.classList.add('hidden'); 
          if (logoutBtn) logoutBtn.classList.remove('hidden');
          
          if (unsubSnapshot) unsubSnapshot();
          
          const docRef = doc(firestore, 'users', user.uid);
          
          unsubSnapshot = onSnapshot(docRef, (docSnap) => {
            if (docSnap.exists()) {
              const cloudDB = docSnap.data().db;
              if (cloudDB && Object.keys(cloudDB).length > 0) {
                if (!window.isFirstSyncDone || JSON.stringify(window.getAppDB()) !== JSON.stringify(cloudDB)) {
                   window.setAppDB(cloudDB);
                   try { localStorage.setItem('nomusa_db_v4', JSON.stringify(cloudDB)); } catch(e){}
                   
                   if(document.getElementById('page-dashboard').classList.contains('active')) window.renderDashboard();
                   if(document.getElementById('page-flashcard').classList.contains('active')) window.renderDueFlashcards();
                   if(document.getElementById('page-exam').classList.contains('active')) window.updateExamQList();
                   if(document.getElementById('page-blank').classList.contains('active')) window.renderOutlineList();
                }
              }
              window.isFirstSyncDone = true;
            } else { 
              window.isFirstSyncDone = true;
              window.triggerCloudSave(); 
            }
          }, (error) => {
            console.error("Firestore onSnapshot Error:", error);
          });
        } else {
          if (statusEl) statusEl.textContent = "로컬 모드 (로그인 안됨)"; 
          if (headerStatus) { headerStatus.textContent = "Mode: Local Storage"; headerStatus.classList.replace('text-blue-400', 'text-slate-400'); }
          if (loginBtn) loginBtn.classList.remove('hidden'); 
          if (logoutBtn) logoutBtn.classList.add('hidden');
          if (unsubSnapshot) { unsubSnapshot(); unsubSnapshot = null; }
        }
      });

      window.triggerCloudSave = () => {
        if (window.currentUser && window.getAppDB) {
          const currentDB = window.getAppDB();
          if (!currentDB || Object.keys(currentDB).length === 0) return;

          const removeUndefined = (obj) => {
            if (Array.isArray(obj)) return obj.map(removeUndefined);
            if (obj !== null && typeof obj === 'object') {
              return Object.keys(obj).reduce((acc, key) => {
                if (obj[key] !== undefined) acc[key] = removeUndefined(obj[key]);
                return acc;
              }, {});
            }
            return obj;
          };

          const sanitizedDB = removeUndefined(currentDB);
          
          setDoc(doc(firestore, 'users', window.currentUser.uid), { db: sanitizedDB }, { merge: true }).catch(err => {
              console.error("Sync Error:", err);
          });
        }
      };
    } catch(e) {
      console.error("Firebase init failed:", e);
      window.loginWithGoogle = () => alert("로그인 오류: 환경 설정을 확인해주세요.");
      window.logoutGoogle = () => {};
      window.triggerCloudSave = () => {};
    }
