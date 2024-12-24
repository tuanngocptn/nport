// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-analytics.js";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyArRxHZJUt4o2RxiLqX1yDSkuUd6ZFy45I",
  authDomain: "nport-link.firebaseapp.com",
  projectId: "nport-link",
  storageBucket: "nport-link.firebasestorage.app",
  messagingSenderId: "515584605320",
  appId: "1:515584605320:web:88daabc8d77146c6e7f33d",
  measurementId: "G-8MYXZL6PGD"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
