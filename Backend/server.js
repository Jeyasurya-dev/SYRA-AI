function sendMessage() {
  const inputBox = document.getElementById("message");
  const replyBox = document.getElementById("reply");

  const userText = inputBox.value.trim();

  // 1️⃣ validation
  if (userText === "") {
    replyBox.innerText = "Please type a message.";
    return;
  }

  // 2️⃣ show loading
  replyBox.innerText = "Thinking...";

  // 3️⃣ send message to NODE backend (NOT python)
  fetch(`${API_BASE}/api/send_message`, {
    method: "POST",
    headers: {
        "Content-Type": "application/json"
    },
    body: JSON.stringify({
        message: userText
    })
})
    .then(response => {
      if (!response.ok) {
        throw new Error("HTTP error " + response.status);
      }
      return response.json();
    })
    .then(data => {
      console.log("Chatbot response:", data);

      let output = "";

      // 4️⃣ main chatbot message
      if (data.message) {
        output += data.message;
      } else {
        output += "No response from chatbot.";
      }

      // 5️⃣ structured results (from CSV)
      if (data.results && data.results.length > 0) {
        output += "\n\n--- Details ---\n";

        data.results.forEach((item, index) => {
          output += `${index + 1}. Crop: ${item.crop || ""}\n`;

          if (item.price) output += `   Price: ${item.price}\n`;
          if (item.fertilizer) output += `   Fertilizer: ${item.fertilizer}\n`;
          if (item.diseases) output += `   Diseases: ${item.diseases}\n`;
          if (item.irrigation) output += `   Irrigation: ${item.irrigation}\n`;
          if (item.state) output += `   State: ${item.state}\n`;

          output += "\n";
        });
      }

      // 6️⃣ display result
      replyBox.innerText = output;

      // 7️⃣ clear input
      inputBox.value = "";
    })
    .catch(error => {
      console.error("Chat error:", error);
      replyBox.innerText = "Error: Unable to connect to chatbot backend.";
    });
}