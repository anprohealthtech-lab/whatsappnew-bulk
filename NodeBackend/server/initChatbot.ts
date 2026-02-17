/**
 * Initialize default chatbot configuration on server startup
 */

import { storage } from "./storage";

const DEFAULT_SYSTEM_PROMPT = `You are AnPro AI Assistant — a Senior Technical Sales Specialist for AnPro Solutions.

TONE: Professional, helpful, and concise. Never overly enthusiastic or pushy. You can respond in Hinglish (Hindi + English mix) if the user writes in Hindi/Hinglish.

MISSION: Help pathology labs understand AnPro AI LIMS. Convert genuine interest into a scheduled Google Meet demo.

IMPORTANT — DEMO VIDEO LINK:
The user has already received the demo video link in the greeting message: https://demo.limsapp.in/demo/cml52cn4j3h6nzsadnq3xl323
- If the user asks about features, demo, or how AnPro works, remind them to watch the video first.
- If they have already watched the video and have specific questions, answer those questions directly.
- Do NOT resend the full greeting. Just reference the video if needed: "Kya aapne demo video dekha? Usme AnPro ke saare key features covered hain."

HARD RULES — YOU MUST FOLLOW THESE:
1. ONE reply per user message. NEVER send multiple messages.
2. Keep replies to 2-4 sentences MAX unless the user explicitly asks for detailed info.
3. Ask at most 1 question per reply. Wait for the user's answer before asking more.
4. You may invite for a demo at most 2 times in the ENTIRE conversation. If declined twice, stop asking.
5. If the user says "not interested", "later", "just browsing", or "busy" — acknowledge politely and STOP pitching. Only re-engage if THEY bring it up.
6. If the user gives short dismissals twice in a row, offer to help later and stop the flow.
7. NEVER send follow-up messages if the user doesn't reply.
8. NEVER repeat the same pitch or CTA in back-to-back replies.
9. Match the user's energy: if they ask one thing, answer ONLY that one thing.

KEY FEATURES (use when relevant):
- AI TRF Digitization: Scan handwritten TRFs, 99% accuracy, zero manual entry.
- AI Instrument Screen Reading: Camera reads analyzer screens — no cables, no HL7.
- Objective AI Analysis: Blood group & rapid card image analysis with proof.
- WhatsApp Integration: Auto-send PDF reports & invoices, included in AI Premium plan.
- Smart Verification: Delta checks, abnormal value flagging (age/gender specific).
- Pricing: Basic ₹2,499/mo | AI Premium ₹3,499/mo (recommended).

VISUALS: If the user asks about a feature with an image reference, include "image url: [URL]" on a new line at the end.
- TRF: image url: https://ik.imagekit.io/18tsendxqy/website/trf%20scan.png?tr=f-auto
- Instrument: image url: https://ik.imagekit.io/18tsendxqy/website/scan%20machine.png?tr=f-auto
- Blood Group: image url: https://ik.imagekit.io/18tsendxqy/website/blood%20group.png?tr=f-auto
- Rapid Card: image url: https://ik.imagekit.io/18tsendxqy/website/rapid%20card.png?tr=f-auto
- WhatsApp: image url: https://ik.imagekit.io/18tsendxqy/website/whatsapp.png?tr=f-auto

POLITE EXIT (use exactly once if user declines):
"Samajh gaye. Aapka time dene ke liye shukriya. Jab bhi aap AI automation explore karna chahein, bas humein message kar dijiye."`;

const DEFAULT_GREETING = `Hello 👋
Welcome to *AnPro Solutions!*

*AnPro LIMS* में interest दिखाने के लिए thank you।

AnPro India का first *AI-based Laboratory Information Management System (LIMS)* है, जो specially modern diagnostic labs के लिए design किया गया है।
यह lab operations को automate करता है, manual work कम करता है, और complete *WhatsApp integration* provide करता है — बिना किसी extra cost के।

आपसे request है कि पहले नीचे दिया गया short introduction video देख लें।
इस video में आपको AnPro का overview, key features, pricing और additional demo video links मिल जाएंगे:

👉 https://demo.limsapp.in/demo/cml52cn4j3h6nzsadnq3xl323

अगर आपको AnPro आपकी lab के लिए suitable लगे, तो इसी number पर हमें वापस contact कीजिए।

आपसे बात करने का इंतज़ार रहेगा 😊

Regards,
*Team AnPro Solutions*
===NEXT_MESSAGE===
Hello 👋

Welcome to *AnPro Solutions!*

Thank you for showing interest in *AnPro LIMS*.

AnPro is India's first AI-based Laboratory Information Management System, specially designed for modern diagnostic laboratories. It helps automate lab operations, reduce manual work, and provides complete WhatsApp integration — without any additional cost.

We request you to please watch the short introduction video below first.
In this video, you will find an overview of AnPro, key features, pricing details, and links to additional demo videos:

👉 https://demo.limsapp.in/demo/cml52cn4j3h6nzsadnq3xl323

If you find AnPro suitable for your lab, please feel free to contact us on this number.

We look forward to speaking with you 😊

Regards,
*Team AnPro Solutions*`;

export async function initializeChatbotConfig() {
  const log = (msg: string) => console.log(`[InitChatbot] ${msg}`);

  try {
    log("Checking chatbot configuration...");

    // Check if config already exists
    const existingConfig = await storage.getChatbotConfig();

    if (existingConfig) {
      // Check if access key is missing and update it
      if (!existingConfig.ragAccessKey || existingConfig.ragAccessKey === '') {
        log("⚠️  Existing config has no access key, updating...");
        const updatedConfig = {
          ...existingConfig,
          ragAccessKey: process.env.RAG_ACCESS_KEY || "71VkYUHciWpo0I8DsK4n8nUfA-Vjr70j",
          isActive: existingConfig.isActive === 'true' ? 'true' : 'false',
        };
        await storage.updateChatbotConfig(updatedConfig);
        log("✅ Access key updated successfully");
      }

      // Backfill system prompt & greeting if missing
      const configAny = existingConfig as any;
      if (!configAny.systemPrompt || !configAny.greetingMessage) {
        log("⚠️  Backfilling system prompt and greeting message...");
        await storage.updateChatbotConfig({
          ...existingConfig,
          systemPrompt: configAny.systemPrompt || DEFAULT_SYSTEM_PROMPT,
          greetingMessage: configAny.greetingMessage || DEFAULT_GREETING,
          contextMessageCount: existingConfig.contextMessageCount || 5,
          replyCooldownSeconds: configAny.replyCooldownSeconds || 8,
          typingDelayMs: configAny.typingDelayMs || 2000,
          isActive: existingConfig.isActive === 'true' ? 'true' : 'false',
        } as any);
        log("✅ System prompt and greeting backfilled");
      } else {
        log("✅ Chatbot configuration already exists");
        log(`   Agent: ${existingConfig.agentName}`);
        log(`   Status: ${existingConfig.isActive === 'true' ? 'Active' : 'Inactive'}`);
        log(`   System prompt: ${configAny.systemPrompt ? `${configAny.systemPrompt.length} chars` : 'NOT SET'}`);
      }
      return;
    }

    // Create default configuration
    log("Creating default chatbot configuration...");

    const defaultConfig = {
      agentName: "AnPro Sales Assistant",
      triggerKeywords: [
        "Hello we are interested in LIMS, please connect with us",
        "LIMS",
        "Demo",
        "Price"
      ],
      ragBaseUrl: "https://tnfqq3vcirfyalnqzg3c4wwy.agents.do-ai.run",
      ragAccessKey: process.env.RAG_ACCESS_KEY || "71VkYUHciWpo0I8DsK4n8nUfA-Vjr70j",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      greetingMessage: DEFAULT_GREETING,
      contextMessageCount: 5,
      replyCooldownSeconds: 8,
      typingDelayMs: 2000,
      isActive: true,
    };

    await storage.updateChatbotConfig(defaultConfig as any);

    log("✅ Default chatbot configuration created successfully");
    log(`   Agent: ${defaultConfig.agentName}`);
    log(`   Trigger keywords: ${defaultConfig.triggerKeywords.length} keywords`);
    log(`   RAG Endpoint: ${defaultConfig.ragBaseUrl}`);
    log(`   Context messages: ${defaultConfig.contextMessageCount}`);
    log(`   Cooldown: ${defaultConfig.replyCooldownSeconds}s`);
    log(`   Typing delay: ${defaultConfig.typingDelayMs}ms`);
    log(`   System prompt: ${defaultConfig.systemPrompt.length} chars`);
    log(`   Status: Active`);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log(`❌ Failed to initialize chatbot config: ${errorMessage}`);
    console.error(error);
  }
}

