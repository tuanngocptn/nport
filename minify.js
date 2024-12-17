const fs = require("fs");
const path = require("path");
const htmlMinifier = require("html-minifier").minify;
const CleanCSS = require("clean-css");
const Terser = require("terser");

// Utility function to read a file
const readFile = (filePath) => fs.readFileSync(filePath, "utf8");

// Utility function to write a file
const writeFile = (filePath, content) =>
  fs.writeFileSync(filePath, content, "utf8");

// Minify CSS
const minifyCSS = (cssPath) => {
  const css = readFile(cssPath);
  return new CleanCSS().minify(css).styles;
};

// Minify JS
const minifyJS = (jsPath) => {
  const js = readFile(jsPath);
  return Terser.minify(js).code;
};

// Main function to minify home.html and its local dependencies
const minifyHTMLWithDependencies = (inputHtmlPath, outputHtmlPath) => {
  let htmlContent = readFile(inputHtmlPath);

  // Match local CSS and JS file references
  const cssRegex = /<link.*?href="(.*?\.css)".*?>/g;
  const jsRegex = /<script.*?src="(.*?\.js)".*?><\/script>/g;

  // Minify and inline local CSS files
  htmlContent = htmlContent.replace(cssRegex, (match, cssPath) => {
    const fullCssPath = path.resolve(path.dirname(inputHtmlPath), cssPath);
    const minifiedCSS = minifyCSS(fullCssPath);
    return `<style>${minifiedCSS}</style>`;
  });

  // Minify and inline local JS files
  htmlContent = htmlContent.replace(jsRegex, (match, jsPath) => {
    const fullJsPath = path.resolve(path.dirname(inputHtmlPath), jsPath);
    const minifiedJS = minifyJS(fullJsPath);
    return `<script>${minifiedJS}</script>`;
  });

  // Minify the final HTML
  const minifiedHTML = htmlMinifier(htmlContent, {
    collapseWhitespace: true,
    removeComments: true,
    removeRedundantAttributes: true,
    useShortDoctype: true,
    removeEmptyAttributes: true,
    minifyCSS: true,
    minifyJS: true,
  });

  // Write to the output file
  writeFile(outputHtmlPath, minifiedHTML);
  console.log(`Minified HTML created at: ${outputHtmlPath}`);
};

// File paths
const inputHtmlPath = path.resolve(__dirname, "home.html");
const outputHtmlPath = path.resolve(__dirname, "index.html");

// Run the minification
minifyHTMLWithDependencies(inputHtmlPath, outputHtmlPath);
