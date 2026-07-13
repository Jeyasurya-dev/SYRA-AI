# =============================================================================
# SYRA AI ENGINE — Multi-Provider Routing with Smart Fallback
# =============================================================================
#
# This module routes requests to different AI providers based on category:
#
#   General Chat  → Gemini → Qwen (OpenRouter) → OpenAI
#   Coding        → Qwen (OpenRouter) → Gemini → OpenAI
#   Website       → Qwen (OpenRouter) → Gemini → OpenAI
#   Project Gen   → Qwen (OpenRouter) → Gemini → OpenAI
#   Agriculture   → Local Knowledge → Gemini → Qwen (OpenRouter)
#   Image Gen     → Replicate (FLUX) [unchanged]
#
# Every feature calls:
#   generate_ai_reply(messages, category=..., ...)         -> str
#   generate_ai_reply_stream(messages, category=..., ...)  -> generator
#
# If a provider fails (timeout, quota, API error, etc.), the engine
# automatically falls back to the next provider in the chain, never
# exposing internal errors to the user.
# =============================================================================

import os
import json
import requests
from dotenv import load_dotenv

load_dotenv("API.env")

# =============================================================================
# CONFIGURATION & ENVIRONMENT
# =============================================================================
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-latest")
GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

OPENROUTER_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_REFERER = "https://syra.ai"
OPENROUTER_TITLE = "SYRA AI Platform"

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_API_BASE = "https://api.openai.com/v1"

# Default Provider
AI_PROVIDER = os.environ.get("AI_PROVIDER", "gemini").strip().lower()

# Qwen Model (OpenRouter)
QWEN_MODEL = os.environ.get("QWEN_MODEL", "qwen/qwen3-coder")

# =============================================================================
# CLOUDFLARE AI
# =============================================================================

CF_ACCOUNT_ID = os.getenv("CLOUDFLARE_ACCOUNT_ID", "")
CF_API_TOKEN = os.getenv("CLOUDFLARE_API_TOKEN", "")

# User-friendly error message shown when all providers fail
FRIENDLY_ERROR = (
    "⚠️ I'm having trouble reaching the AI service right now. "
    "Please try again in a moment."
)

# Log warnings about missing keys
_missing_keys = []
if not GEMINI_API_KEY:
    _missing_keys.append("GEMINI_API_KEY")
if not OPENROUTER_KEY:
    _missing_keys.append("OPENROUTER_API_KEY")
if not OPENAI_API_KEY:
    _missing_keys.append("OPENAI_API_KEY")

if _missing_keys:
    print(f"WARNING: Missing keys for: {', '.join(_missing_keys)}. "
          "Some AI features will be limited.")

# =============================================================================
# PROVIDER IMPLEMENTATIONS
# =============================================================================

def _to_gemini_payload(messages, temperature, max_tokens):
    """Converts OpenAI-style messages to Gemini format."""
    system_parts = [m["content"] for m in messages if m.get("role") == "system"]
    contents = []
    for m in messages:
        if m.get("role") == "system":
            continue
        role = "user" if m.get("role") == "user" else "model"
        contents.append({"role": role, "parts": [{"text": m.get("content", "")}]})

    payload = {
        "contents": contents,
        "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens},
    }
    if system_parts:
        payload["systemInstruction"] = {"parts": [{"text": "\n\n".join(system_parts)}]}
    return payload


def _gemini_complete(messages, model_id, temperature, max_tokens):
    """Non-streaming Gemini completion."""
    if not GEMINI_API_KEY:
        return None
    try:
        url = f"{GEMINI_API_BASE}/{model_id}:generateContent?key={GEMINI_API_KEY}"
        payload = _to_gemini_payload(messages, temperature, max_tokens)
        res = requests.post(url, json=payload, timeout=30)
        if res.status_code != 200:
            print(f"[ai_engine] Gemini error: {res.status_code}")
            return None
        data = res.json()
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except requests.Timeout:
        print("[ai_engine] Gemini timeout")
        return None
    except Exception as e:
        print(f"[ai_engine] Gemini error: {e}")
        return None


def _gemini_stream(messages, model_id, max_tokens):
    """Streaming Gemini completion."""
    if not GEMINI_API_KEY:
        raise RuntimeError("Gemini not configured")
    try:
        url = f"{GEMINI_API_BASE}/{model_id}:streamGenerateContent?alt=sse&key={GEMINI_API_KEY}"
        payload = _to_gemini_payload(messages, 0.7, max_tokens)
        with requests.post(url, json=payload, timeout=60, stream=True) as res:
            if res.status_code != 200:
                raise RuntimeError(f"Gemini returned {res.status_code}")
            for line in res.iter_lines():
                if not line:
                    continue
                decoded = line.decode("utf-8", errors="ignore")
                if not decoded.startswith("data: "):
                    continue
                chunk = decoded[6:]
                try:
                    obj = json.loads(chunk)
                    text = obj["candidates"][0]["content"]["parts"][0].get("text", "")
                    if text:
                        yield f"data: {json.dumps({'text': text})}\n\n"
                except Exception:
                    pass
            yield "data: [DONE]\n\n"
    except requests.Timeout:
        raise RuntimeError("Gemini stream timeout")
    except Exception as e:
        raise RuntimeError(f"Gemini stream error: {e}")


def _openrouter_headers():
    """OpenRouter request headers."""
    return {
        "Authorization": f"Bearer {OPENROUTER_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": OPENROUTER_REFERER,
        "X-Title": OPENROUTER_TITLE,
    }


def _openrouter_complete(messages, model_id, temperature, max_tokens):
    """Non-streaming OpenRouter completion."""
    if not OPENROUTER_KEY:
        return None
    try:
        payload = {
            "model": model_id,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        res = requests.post(OPENROUTER_URL, headers=_openrouter_headers(), json=payload, timeout=60)
        if res.status_code != 200:
            print(f"[ai_engine] OpenRouter error: {res.status_code}")
            return None
        return res.json()["choices"][0]["message"]["content"]
    except requests.Timeout:
        print("[ai_engine] OpenRouter timeout")
        return None
    except Exception as e:
        print(f"[ai_engine] OpenRouter error: {e}")
        return None


def _openrouter_stream(messages, model_id, max_tokens):
    """Streaming OpenRouter completion."""
    if not OPENROUTER_KEY:
        raise RuntimeError("OpenRouter not configured")
    try:
        payload = {"model": model_id, "messages": messages, "max_tokens": max_tokens, "stream": True}
        with requests.post(OPENROUTER_URL, headers=_openrouter_headers(), json=payload, timeout=120, stream=True) as res:
            if res.status_code != 200:
                raise RuntimeError(f"OpenRouter returned {res.status_code}")
            for line in res.iter_lines():
                if not line:
                    continue
                decoded = line.decode("utf-8", errors="ignore")
                if not decoded.startswith("data: "):
                    continue
                chunk = decoded[6:]
                if chunk.strip() == "[DONE]":
                    yield "data: [DONE]\n\n"
                    return
                try:
                    obj = json.loads(chunk)
                    text = obj["choices"][0]["delta"].get("content", "")
                    if text:
                        yield f"data: {json.dumps({'text': text})}\n\n"
                except Exception:
                    pass
            yield "data: [DONE]\n\n"
    except requests.Timeout:
        raise RuntimeError("OpenRouter stream timeout")
    except Exception as e:
        raise RuntimeError(f"OpenRouter stream error: {e}")


def _openai_complete(messages, model_id, temperature, max_tokens):
    """Non-streaming OpenAI completion."""
    if not OPENAI_API_KEY:
        return None
    try:
        url = f"{OPENAI_API_BASE}/chat/completions"
        headers = {
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model_id,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        res = requests.post(url, headers=headers, json=payload, timeout=30)
        if res.status_code != 200:
            print(f"[ai_engine] OpenAI error: {res.status_code}")
            return None
        return res.json()["choices"][0]["message"]["content"]
    except requests.Timeout:
        print("[ai_engine] OpenAI timeout")
        return None
    except Exception as e:
        print(f"[ai_engine] OpenAI error: {e}")
        return None


def _openai_stream(messages, model_id, temperature, max_tokens):
    """Streaming OpenAI completion."""
    if not OPENAI_API_KEY:
        raise RuntimeError("OpenAI not configured")
    try:
        url = f"{OPENAI_API_BASE}/chat/completions"
        headers = {
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model_id,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": True,
        }
        with requests.post(url, headers=headers, json=payload, timeout=60, stream=True) as res:
            if res.status_code != 200:
                raise RuntimeError(f"OpenAI returned {res.status_code}")
            for line in res.iter_lines():
                if not line:
                    continue
                decoded = line.decode("utf-8", errors="ignore")
                if not decoded.startswith("data: "):
                    continue
                chunk = decoded[6:]
                if chunk.strip() == "[DONE]":
                    yield "data: [DONE]\n\n"
                    return
                try:
                    obj = json.loads(chunk)
                    text = obj["choices"][0]["delta"].get("content", "")
                    if text:
                        yield f"data: {json.dumps({'text': text})}\n\n"
                except Exception:
                    pass
            yield "data: [DONE]\n\n"
    except requests.Timeout:
        raise RuntimeError("OpenAI stream timeout")
    except Exception as e:
        raise RuntimeError(f"OpenAI stream error: {e}")


# =============================================================================
# PROVIDER REGISTRY
# =============================================================================
_PROVIDERS = {
    "gemini": {"complete": _gemini_complete, "stream": _gemini_stream},
    "openrouter": {"complete": _openrouter_complete, "stream": _openrouter_stream},
    "openai": {"complete": _openai_complete, "stream": _openai_stream},
}

# Provider chains per category: [primary, fallback1, fallback2]
_PROVIDER_CHAINS = {
    "chat": [
        ("gemini", GEMINI_MODEL),
        ("openrouter", QWEN_MODEL),
        ("openai", OPENAI_MODEL),
    ],

    "coding": [
        ("openrouter", QWEN_MODEL),
        ("gemini", GEMINI_MODEL),
        ("openai", OPENAI_MODEL),
    ],

    "website": [
        ("openrouter", QWEN_MODEL),
        ("gemini", GEMINI_MODEL),
        ("openai", OPENAI_MODEL),
    ],

    "project": [
        ("openrouter", QWEN_MODEL),
        ("gemini", GEMINI_MODEL),
        ("openai", OPENAI_MODEL),
    ],

    "agri": [
        ("local", "local"),
        ("gemini", GEMINI_MODEL),
        ("openrouter", QWEN_MODEL),
    ],
}

# =============================================================================
# CATEGORY RESOLUTION
# =============================================================================
def get_provider_chain(category):
    """Returns the provider chain for a category, with configured API keys."""
    chain = _PROVIDER_CHAINS.get(category, _PROVIDER_CHAINS["chat"])
    # Filter out providers without keys
    available = []
    for provider, model_id in chain:
        if provider == "local":
            available.append((provider, model_id))
        elif provider == "gemini" and GEMINI_API_KEY:
            available.append((provider, model_id))
        elif provider == "openrouter" and OPENROUTER_KEY:
            available.append((provider, model_id))
        elif provider == "openai" and OPENAI_API_KEY:
            available.append((provider, model_id))
    
    # If no providers available, return all (they'll fail gracefully)
    if not available:
        return chain
    return available


# =============================================================================
# LOCAL KNOWLEDGE BASE (for Agriculture)
# =============================================================================
_LOCAL_KNOWLEDGE_BASE = {
    # Crops and their management
    "rice": {
        "soil": "pH 5.5-7.5, well-drained paddies",
        "water": "5-10 cm standing water, 1200-1500 mm seasonal rainfall",
        "fertilizer": "Urea: 60kg/acre, DAP: 40kg/acre, Potash: 30kg/acre",
        "duration": "90-120 days",
        "pests": "Stem borer, leaf folder, blast fungus",
        "price_range": "₹2000-2500 per quintal",
    },
    "wheat": {
        "soil": "Well-drained loam, pH 6.0-7.5",
        "water": "400-500 mm rainfall, 3-4 irrigations",
        "fertilizer": "Urea: 80kg/acre, DAP: 50kg/acre, Potash: 30kg/acre",
        "duration": "120-150 days",
        "pests": "Armyworm, Hessian fly, Karnal bunt",
        "price_range": "₹2500-3000 per quintal",
    },
    "cotton": {
        "soil": "Well-drained loam, pH 6.0-8.0",
        "water": "500-750 mm, 4-5 irrigations",
        "fertilizer": "Urea: 100kg/acre, DAP: 50kg/acre, Potash: 50kg/acre",
        "duration": "150-180 days",
        "pests": "Bollworm, aphids, whitefly",
        "price_range": "₹5500-6500 per quintal",
    },
    "sugarcane": {
        "soil": "Deep loamy soil, pH 6.0-8.0",
        "water": "1500-2000 mm, 15-20 irrigations",
        "fertilizer": "Urea: 150kg/acre, DAP: 75kg/acre, Potash: 75kg/acre",
        "duration": "12 months",
        "pests": "Top borer, scale insects",
        "price_range": "₹3000-4000 per ton",
    },
}


def _local_knowledge_complete(messages, model_id, temperature, max_tokens):
    """Local agricultural knowledge base response."""
    user_text = ""
    for msg in reversed(messages):
        if msg.get("role") == "user":
            user_text = msg.get("content", "").lower()
            break
    
    # Simple keyword matching for crop recommendations
    for crop_name, info in _LOCAL_KNOWLEDGE_BASE.items():
        if crop_name in user_text:
            response = f"Based on local knowledge for {crop_name.upper()}:\n\n"
            response += f"🌱 Soil: {info['soil']}\n"
            response += f"💧 Water: {info['water']}\n"
            response += f"🧪 Fertilizer: {info['fertilizer']}\n"
            response += f"⏱️ Duration: {info['duration']}\n"
            response += f"🐛 Pests: {info['pests']}\n"
            response += f"💰 Market Price: {info['price_range']}\n\n"
            response += "For personalized advice, consult a local agricultural officer."
            return response
    
    # No local knowledge matched, return None to trigger fallback
    return None


def _local_knowledge_stream(messages, model_id, max_tokens):
    """Streaming local knowledge (converts to chunked stream)."""
    reply = _local_knowledge_complete(messages, model_id, 0.7, max_tokens)
    if reply:
        # Split into chunks and stream
        words = reply.split()
        chunk = ""
        for word in words:
            chunk += word + " "
            if len(chunk) > 100:
                yield f"data: {json.dumps({'text': chunk})}\n\n"
                chunk = ""
        if chunk:
            yield f"data: {json.dumps({'text': chunk})}\n\n"
        yield "data: [DONE]\n\n"
    else:
        raise RuntimeError("Local knowledge not applicable")


_PROVIDERS["local"] = {"complete": _local_knowledge_complete, "stream": _local_knowledge_stream}


# =============================================================================
# PUBLIC ENTRY POINTS
# =============================================================================
def generate_ai_reply(messages, category="chat", temperature=0.7, max_tokens=2048):
    """
    Non-streaming text generation with automatic fallback.
    
    Args:
        messages: OpenAI-style message list
        category: Request category ("chat", "coding", "website", "project", "agri")
        temperature: Sampling temperature
        max_tokens: Max response tokens
    
    Returns:
        Reply text, or FRIENDLY_ERROR if all providers fail
    """
    chain = get_provider_chain(category)
    
    for provider_name, model_id in chain:
        try:
            if provider_name not in _PROVIDERS:
              continue

            print("=" * 60)
            print(f"Category : {category}")
            print(f"Provider : {provider_name}")
            print(f"Model    : {model_id}")
            print("=" * 60)

            reply = _PROVIDERS[provider_name]["complete"](
              messages, model_id, temperature, max_tokens
            )
            
            if reply:
                return reply
        except Exception as e:
            print(f"[ai_engine] Provider '{provider_name}' failed: {e}")
            continue
    
    return FRIENDLY_ERROR


def generate_ai_reply_stream(messages, category="chat", max_tokens=2048):
    """
    Streaming text generation with automatic fallback.
    
    Args:
        messages: OpenAI-style message list
        category: Request category
        max_tokens: Max response tokens
    
    Yields:
        Server-Sent-Event formatted chunks, or error chunk if all fail
    """
    chain = get_provider_chain(category)
    
    for provider_name, model_id in chain:
        try:
            if provider_name not in _PROVIDERS:
              continue

            print("=" * 60)
            print(f"Category : {category}")
            print(f"Provider : {provider_name}")
            print(f"Model    : {model_id}")
            print("=" * 60)

            got_any = False

            for chunk in _PROVIDERS[provider_name]["stream"](
               messages,
               model_id,
               max_tokens
            ):
               got_any = True
               yield chunk

            if got_any:
              return

        except Exception as e:
            print(f"[ai_engine] Streaming provider '{provider_name}' failed: {e}")
            continue

# All providers failed
    yield f"data: {json.dumps({'text': FRIENDLY_ERROR})}\n\n"
    yield "data: [DONE]\n\n"


# =============================================================================
# CLOUDFARE WHISPER (Speech To Text)
# =============================================================================

def cloudflare_speech_to_text(audio_path):
    """
    Speech-to-Text using Cloudflare AI Whisper.
    """

    if not CF_ACCOUNT_ID or not CF_API_TOKEN:
        raise RuntimeError("Cloudflare AI credentials not configured.")

    url = (
        f"https://api.cloudflare.com/client/v4/accounts/"
        f"{CF_ACCOUNT_ID}/ai/run/@cf/openai/whisper-large-v3-turbo"
    )

    headers = {
        "Authorization": f"Bearer {CF_API_TOKEN}"
    }

    with open(audio_path, "rb") as audio:

        response = requests.post(
            url,
            headers=headers,
            files={"audio": audio},
            timeout=120
        )

    data = response.json()

    if not response.ok:

        raise RuntimeError(str(data))

    return data.get("result", {}).get("text", "")