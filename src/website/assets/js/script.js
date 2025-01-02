(() => {
  // Copy command functionality for both locations
  document.querySelectorAll(".content h2 code, .feature code").forEach((codeElement) => {
    codeElement.addEventListener("click", async (e) => {
      try {
        const textToCopy = e.target.textContent.replace("$ ", "");
        await navigator.clipboard.writeText(textToCopy);

        const feedback = document.createElement("div");
        feedback.className = "copy-feedback";
        feedback.textContent = "Copied! 📋";
        document.body.appendChild(feedback);

        feedback.style.left = `${e.clientX + 10}px`;
        feedback.style.top = `${e.clientY - 20}px`;

        requestAnimationFrame(() => feedback.classList.add("show"));

        e.target.style.backgroundColor = "#2d2d2d";

        setTimeout(() => {
          e.target.style.backgroundColor = "#1e1e1e";
          feedback.classList.remove("show");
          setTimeout(() => feedback.remove(), 200);
        }, 1000);
      } catch (err) {
        console.error("Failed to copy text: ", err);
      }
    });
  });
})();
