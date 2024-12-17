document
  .querySelector(".content h2 code")
  .addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText("npm i -g nport");
      // Optional: Add visual feedback when copied
      const code = document.querySelector(".content h2 code");
      code.style.backgroundColor = "rgba(0, 255, 0, 0.2)";
      setTimeout(() => {
        code.style.backgroundColor = "rgba(255, 255, 255, 0.1)";
      }, 500);
    } catch (err) {
      console.error("Failed to copy text: ", err);
    }
  });
