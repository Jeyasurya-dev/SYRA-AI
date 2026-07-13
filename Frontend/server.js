const express = require("express");
const path = require("path");
const axios = require("axios");

const app = express();
const PORT = 5000;
const PY_BACKEND = "http://127.0.0.1:5001";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* CHAT PROXY */
app.post("/api/send_message", async (req, res) => {
  try {
    const resp = await axios.post(`${PY_BACKEND}/api/chat`, {
      message: req.body.message
    });
    res.json(resp.data);
  } catch (err) {
    res.status(500).json({ message: "Python backend not reachable" });
  }
});

/* DEFAULT PAGE */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("=======================================");
  console.log(`✅ UI Server running : http://127.0.0.1:${PORT}`);
  console.log(`🤖 Chatbot backend  : ${PY_BACKEND}`);
  console.log("=======================================");
});