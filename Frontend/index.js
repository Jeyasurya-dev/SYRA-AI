require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 4000;

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(bodyParser.json());

// ---------- TEMP STORAGE (demo purpose) ----------
const otpStore = {}; // { email: otp }

// ---------- MAIL CONFIG ----------
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// ---------- SEND OTP ----------
async function sendOTP(email) {

    const res = await fetch(`${API_BASE}/api/send-otp`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            email: email
        })
    });

    return await res.json();
}

document.getElementById("sendOtpBtn").addEventListener("click", async () => {

    const email = document.getElementById("emailInput").value.trim();

    if (!email) {

        alert("Enter Email");

        return;

    }

    const result = await sendOTP(email);

    alert(result.message);

});

// ---------- VERIFY OTP ----------
async function verifyOTP(email, otp) {

    const response = await fetch(`${API_BASE}/api/verify-otp`, {

        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        credentials: "include",

        body: JSON.stringify({

            email: email,
            otp: otp

        })

    });

    const data = await response.json();

    if (data.ok) {

        await checkSession();

    }

    return data;

}

document.getElementById("verifyOtpBtn").addEventListener("click", async () => {

    const email = document.getElementById("emailInput").value.trim();

    const otp = document.getElementById("otpInput").value.trim();

    if (!otp) {

        alert("Enter OTP");

        return;

    }

    const result = await verifyOTP(email, otp);

    if (result.ok) {

        alert("Login Successful");

    } else {

        alert(result.message);

    }

});

// ---------- HEALTH CHECK ----------
app.get("/", (req, res) => {
  res.send("Auth backend running");
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`Auth backend running on http://localhost:${PORT}`);
});