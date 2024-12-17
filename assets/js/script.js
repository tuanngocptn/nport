document
  .querySelector(".content h2 code")
  .addEventListener("click", async () => {
    try {
      const textToCopy = document.querySelector(".content h2 code").textContent;
      await navigator.clipboard.writeText(textToCopy);
      const code = document.querySelector(".content h2 code");
      code.style.backgroundColor = "#2d2d2d";
      setTimeout(() => {
        code.style.backgroundColor = "#1e1e1e";
      }, 500);
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
