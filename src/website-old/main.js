// Import CSS
import './assets/css/style.css'; // Adjust path based on your Webpack config

// Import JavaScript files
import './assets/js/script.js'; // Main script file

// Log a message to verify the bundling process
console.log('Minify.js: All assets are bundled and minified.');

// Additional JavaScript (if any)
function initializeApp() {
  console.log('Application initialized.');
}

initializeApp();