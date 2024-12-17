document
  .querySelector(".content h2 code")
  .addEventListener("click", async (e) => {
    try {
      const code = document.querySelector(".content h2 code");
      const textToCopy = code.textContent.replace('$ ', '');
      await navigator.clipboard.writeText(textToCopy);
      
      // Create and show feedback element
      const feedback = document.createElement('div');
      feedback.className = 'copy-feedback';
      feedback.textContent = 'Copied! 📋';
      document.body.appendChild(feedback);
      
      // Position feedback near click
      feedback.style.left = `${e.clientX + 10}px`;
      feedback.style.top = `${e.clientY - 20}px`;
      
      // Show feedback
      requestAnimationFrame(() => feedback.classList.add('show'));
      
      // Background effect
      code.style.backgroundColor = "#2d2d2d";
      
      // Reset everything
      setTimeout(() => {
        code.style.backgroundColor = "#1e1e1e";
        feedback.classList.remove('show');
        setTimeout(() => feedback.remove(), 200);
      }, 1000);
    } catch (err) {
      console.error("Failed to copy text: ", err);
    }
  });

document.querySelector(".show-more").addEventListener("click", (e) => {
  const mainCode = document.querySelector(".content h2 code");
  const button = e.target;
  const isShowingInstall = mainCode.textContent === "npm i -g nport";
  
  if (isShowingInstall) {
    mainCode.textContent = "nport -s myapp -p 3000";
    button.textContent = "Show install command 📦";
  } else {
    mainCode.textContent = "npm i -g nport";
    button.textContent = "Show usage examples 🚀";
  }
});

document
  .querySelector(".command-list code")
  .addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText("nport -s myapp -p 3000");
      const code = document.querySelector(".command-list code");
      code.style.backgroundColor = "#2d2d2d";
      setTimeout(() => {
        code.style.backgroundColor = "#1e1e1e";
      }, 500);
    } catch (err) {
      console.error("Failed to copy text: ", err);
    }
  });
