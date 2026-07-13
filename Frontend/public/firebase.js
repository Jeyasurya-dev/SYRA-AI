const firebaseConfig = {
  apiKey: "AIzaSyBKG9HEy_rB2gjB6ioebhNBBouDcspN04M",
  authDomain: "zyra-ai-baedf.firebaseapp.com",
  projectId: "zyra-ai-baedf",
  storageBucket: "zyra-ai-baedf.firebasestorage.app",
  messagingSenderId: "311095546739",
  appId: "1:311095546739:web:72295cb658c56048df2b06",
  measurementId: "G-4PCGPZGF3S"
};

firebase.initializeApp(firebaseConfig);

window.firebaseAuth = firebase.auth();
window.googleProvider = new firebase.auth.GoogleAuthProvider();