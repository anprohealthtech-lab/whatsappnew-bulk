/**
 * ChatbotService - Manages lead detection and RAG chatbot integration
 *
 * Features:
 * - Detects lead trigger keywords (exact match, case-insensitive)
 * - Flags contacts as leads
 * - Retrieves conversation history
 * - Calls Digital Ocean RAG endpoint with system prompt + conversation context
 * - Formats messages in OpenAI-compatible format
 * - Auto-replies to leads via WhatsApp with cooldown & typing delay
 * - Downloads and sends images from URLs provided by chatbot
 * - Tracks conversation state (demo ask count, user intent)
 * - Enforces reply cooldown to prevent aggressive multi-messaging
 */

import type { IStorage } from "../storage";
import type { ChatbotConfig, Contact, Message } from "@shared/schema";
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';

interface RagMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface RagRequest {
  messages: RagMessage[];
  stream: boolean;
  include_functions_info: boolean;
  include_retrieval_info?: boolean;
  include_guardrails_info?: boolean;
}

interface RagResponse {
  choices: Array<{
    message: {
      role: string;
      content: string;
      tool_calls?: Array<{
        tool_name: string;
        output: any;
      }>;
    };
  }>;
}

interface ConversationState {
  demoAskedCount: number;
  userIntent: 'unknown' | 'interested' | 'browsing' | 'declined' | 'booked';
  lastBotReplyAt: string | null;
  messageCount: number;
}

type GreetingItem =
  | { kind: 'text'; value: string }
  | { kind: 'audio'; value: string }
  | { kind: 'audio_url'; value: string };

const DEFAULT_CONVERSATION_STATE: ConversationState = {
  demoAskedCount: 0,
  userIntent: 'unknown',
  lastBotReplyAt: null,
  messageCount: 0,
};

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

// In-memory cooldown tracker (per phone number)
const lastReplyTimestamps = new Map<string, number>();

// Pending greetings that failed due to WhatsApp being disconnected
const pendingGreetings = new Map<string, { keyword: string; replyToJid?: string; timestamp: number }>();

export class ChatbotService {
  constructor(
    private storage: IStorage,
    private whatsappService: any
  ) {
    // Listen for WhatsApp reconnection to retry pending greetings
    if (this.whatsappService?.on) {
      this.whatsappService.on('whatsapp-authenticated', () => {
        this.retryPendingGreetings();
      });
    }
  }

  /**
   * Retry greetings that failed because WhatsApp was disconnected
   */
  private async retryPendingGreetings(): Promise<void> {
    if (pendingGreetings.size === 0) return;

    const log = (msg: string) => console.log(`[ChatbotService] ${msg}`);
    log(`🔄 WhatsApp reconnected — retrying ${pendingGreetings.size} pending greeting(s)`);

    // Copy and clear to avoid infinite loops
    const toRetry = new Map(pendingGreetings);
    pendingGreetings.clear();

    // Wait 5 seconds for connection to stabilize
    await new Promise(resolve => setTimeout(resolve, 5000));

    for (const [phoneNumber, info] of Array.from(toRetry.entries())) {
      // Skip if too old (> 1 hour)
      if (Date.now() - info.timestamp > 60 * 60 * 1000) {
        log(`⏭️ Skipping stale pending greeting for ${phoneNumber} (${Math.round((Date.now() - info.timestamp) / 60000)}min old)`);
        continue;
      }

      try {
        log(`🔄 Retrying greeting for ${phoneNumber}`);
        const config = await this.storage.getChatbotConfig();
        const greetingRaw = (config as any)?.greetingMessage || DEFAULT_GREETING;
        const greetingParts = this.parseGreetingItems(greetingRaw);

        for (let i = 0; i < greetingParts.length; i++) {
          const part = greetingParts[i];
          if (i > 0) await new Promise(resolve => setTimeout(resolve, 1500));

          try {
            if (part.kind === 'audio') {
              await this.whatsappService.sendMediaMessage(info.replyToJid || phoneNumber, part.value);
            } else if (part.kind === 'audio_url') {
              await this.downloadAndSendAudio(phoneNumber, part.value, info.replyToJid);
            } else {
              await this.whatsappService.sendTextMessage(info.replyToJid || phoneNumber, part.value);
            }
          } catch (sendError: any) {
            log(`⚠️ Retry failed for ${phoneNumber} part ${i + 1}: ${this.errorMessage(sendError)}`);
            if (this.errorMessage(sendError).includes('not connected')) {
              pendingGreetings.set(phoneNumber, info);
              break;
            }
            continue;
          }

          await this.storage.createMessage({
            phoneNumber,
            content: (part.kind === 'audio' || part.kind === 'audio_url') ? `[Voice Note] ${part.value}` : part.value,
            type: (part.kind === 'audio' || part.kind === 'audio_url') ? "audio" : "text",
            status: "sent",
            metadata: {
              chatbot_greeting: true,
              trigger_keyword: info.keyword,
              greeting_kind: part.kind,
              greeting_part: i + 1,
              greeting_total: greetingParts.length,
              retried: true,
            },
          });
        }
        log(`✅ Retry greeting sent to ${phoneNumber}`);
      } catch (error: any) {
        log(`⚠️ Retry greeting failed for ${phoneNumber}: ${this.errorMessage(error)}`);
      }
    }
  }

  /**
   * Detect if message text contains any configured trigger keyword (case-insensitive word match)
   */
  async detectLeadTrigger(messageText: string): Promise<string | null> {
    const config = await this.storage.getChatbotConfig();

    if (!config || config.isActive !== "true") {
      return null;
    }

    const keywords = (config.triggerKeywords as string[]) || [];
    const fallbackKeywords = [
      'Hello! Can I get more info on this?',
    ];
    const allKeywords = [...keywords, ...fallbackKeywords];
    const normalizedMessage = messageText.trim().toLowerCase();
    const canonicalMessage = normalizedMessage.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

    for (const keyword of allKeywords) {
      const normalizedKeyword = keyword.trim().toLowerCase();
      const canonicalKeyword = normalizedKeyword.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

      // Check for exact match first (for multi-word keywords)
      if (normalizedMessage === normalizedKeyword || canonicalMessage === canonicalKeyword) {
        return keyword;
      }

      // Check if keyword appears as a whole word in the message
      const wordBoundaryRegex = new RegExp(`\\b${normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (wordBoundaryRegex.test(messageText)) {
        return keyword;
      }
    }

    return null;
  }

  /**
   * Flag a phone number as a lead and send initial greeting
   */
  async flagAsLead(phoneNumber: string, keyword: string, name?: string, replyToJid?: string): Promise<Contact> {
    const log = (msg: string) => console.log(`[ChatbotService] ${msg}`);

    log(`Flagging ${phoneNumber} as lead (trigger: "${keyword}")`);

    const contact = await this.storage.flagAsLead(phoneNumber, keyword, name);

    // Initialize conversation state
    await this.storage.updateContact(phoneNumber, {
      conversationState: { ...DEFAULT_CONVERSATION_STATE, messageCount: 1 },
    });

    log(`✅ ${phoneNumber} flagged as lead`);

    // Send initial greeting message(s)
    // Supports multiple messages separated by ===NEXT_MESSAGE===
    try {
      const config = await this.storage.getChatbotConfig();
      const greetingRaw = (config as any)?.greetingMessage || DEFAULT_GREETING;
      const greetingParts = this.parseGreetingItems(greetingRaw);

      // Check WhatsApp connection before attempting to send
      if (!this.whatsappService?.status?.isConnected) {
        log(`⚠️ WhatsApp not connected — queueing greeting for ${phoneNumber} to retry later`);
        // Store pending greeting so it can be retried
        pendingGreetings.set(phoneNumber, { keyword, replyToJid, timestamp: Date.now() });
        return contact;
      }

      log(`Sending ${greetingParts.length} greeting item(s) to new lead ${phoneNumber}`);

      let sentCount = 0;
      let failedCount = 0;

      for (let i = 0; i < greetingParts.length; i++) {
        const part = greetingParts[i];

        // Small delay between messages (1.5s) so they arrive in order
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 1500));
        }

        try {
          if (part.kind === 'audio') {
            await this.whatsappService.sendMediaMessage(replyToJid || phoneNumber, part.value);
          } else if (part.kind === 'audio_url') {
            await this.downloadAndSendAudio(phoneNumber, part.value, replyToJid);
          } else {
            await this.whatsappService.sendTextMessage(replyToJid || phoneNumber, part.value);
          }
          sentCount++;
        } catch (sendError: any) {
          failedCount++;
          log(`⚠️ Failed to send greeting part ${i + 1}/${greetingParts.length} (${part.kind}): ${this.errorMessage(sendError)}`);
          // If WhatsApp disconnected mid-greeting, stop trying and queue for retry
          if (this.errorMessage(sendError).includes('not connected')) {
            log(`⏸️ WhatsApp disconnected mid-greeting — queueing remaining parts for ${phoneNumber}`);
            pendingGreetings.set(phoneNumber, { keyword, replyToJid, timestamp: Date.now() });
            break;
          }
          continue;
        }

        // Store each greeting item in DB only if sent successfully
        await this.storage.createMessage({
          phoneNumber,
          content: (part.kind === 'audio' || part.kind === 'audio_url') ? `[Voice Note] ${part.value}` : part.value,
          type: (part.kind === 'audio' || part.kind === 'audio_url') ? "audio" : "text",
          status: "sent",
          metadata: {
            chatbot_greeting: true,
            trigger_keyword: keyword,
            greeting_kind: part.kind,
            greeting_part: i + 1,
            greeting_total: greetingParts.length,
          },
        });
      }

      // Record reply timestamp for cooldown
      if (sentCount > 0) {
        lastReplyTimestamps.set(phoneNumber, Date.now());
      }

      if (failedCount > 0) {
        log(`⚠️ ${sentCount}/${greetingParts.length} greeting item(s) sent to ${phoneNumber} (${failedCount} failed)`);
      } else {
        log(`✅ ${sentCount}/${greetingParts.length} greeting item(s) sent to ${phoneNumber}`);
      }
    } catch (error: any) {
      log(`⚠️ Failed to send greeting message: ${this.errorMessage(error)}`);
    }

    return contact;
  }

  /**
   * Check if a phone number is already a lead
   */
  async isLead(phoneNumber: string): Promise<boolean> {
    return await this.storage.isLead(phoneNumber);
  }

  /**
   * Check if reply cooldown has passed for this phone number
   */
  isOnCooldown(phoneNumber: string, cooldownSeconds: number): boolean {
    const lastReply = lastReplyTimestamps.get(phoneNumber);
    if (!lastReply) return false;

    const elapsed = (Date.now() - lastReply) / 1000;
    return elapsed < cooldownSeconds;
  }

  /**
   * Get conversation history for a phone number
   * Returns messages ordered chronologically (oldest first)
   */
  async getConversationHistory(phoneNumber: string, limit: number = 5): Promise<Message[]> {
    const messages = await this.storage.getConversationHistory(phoneNumber, limit);

    // Reverse to get chronological order (oldest first)
    return messages.reverse();
  }

  /**
   * Get or initialize conversation state for a contact
   */
  async getConversationState(phoneNumber: string): Promise<ConversationState> {
    const contact = await this.storage.getContact(phoneNumber);
    if (contact?.conversationState && typeof contact.conversationState === 'object') {
      return { ...DEFAULT_CONVERSATION_STATE, ...(contact.conversationState as any) };
    }
    return { ...DEFAULT_CONVERSATION_STATE };
  }

  /**
   * Update conversation state
   */
  async updateConversationState(phoneNumber: string, updates: Partial<ConversationState>): Promise<void> {
    const current = await this.getConversationState(phoneNumber);
    const newState = { ...current, ...updates };
    await this.storage.updateContact(phoneNumber, {
      conversationState: newState,
    });
  }

  /**
   * Format conversation history into OpenAI-compatible message format
   * Maps: incoming (from lead) -> role: "user", outgoing (from bot) -> role: "assistant"
   */
  formatConversationForRAG(messages: Array<{ content: string; type: string }>): RagMessage[] {
    return messages.map(msg => {
      const role = msg.type === "incoming" ? "user" : "assistant";
      return { role, content: msg.content };
    });
  }

  /**
   * Build the system prompt with conversation state context
   */
  buildSystemPrompt(
    config: ChatbotConfig,
    state: ConversationState,
    voiceContext?: {
      requestedInLatestMessage: boolean;
      alreadySentEarlier: boolean;
      configuredInGreeting: boolean;
    }
  ): string {
    const basePrompt = (config as any).systemPrompt || DEFAULT_SYSTEM_PROMPT;

    // Append conversation state context so the AI knows where the conversation stands
    const stateContext = [
      `\n\n--- CONVERSATION STATE (internal, do not reveal to user) ---`,
      `Demo asked count: ${state.demoAskedCount}/2`,
      `User intent: ${state.userIntent}`,
      `Messages exchanged: ${state.messageCount}`,
      state.demoAskedCount >= 2 ? `IMPORTANT: You have already asked for a demo 2 times. Do NOT ask again.` : '',
      state.userIntent === 'declined' ? `IMPORTANT: The user has declined. Do NOT pitch or push. Only respond if they re-engage.` : '',
      voiceContext ? `Voice note requested in latest message: ${voiceContext.requestedInLatestMessage ? 'yes' : 'no'}` : '',
      voiceContext ? `Voice note already sent earlier: ${voiceContext.alreadySentEarlier ? 'yes' : 'no'}` : '',
      voiceContext ? `Voice note configured in greeting: ${voiceContext.configuredInGreeting ? 'yes' : 'no'}` : '',
      voiceContext?.requestedInLatestMessage && !voiceContext.alreadySentEarlier
        ? `If user asked for voice note, acknowledge naturally that a voice note is being shared.`
        : '',
    ].filter(Boolean).join('\n');

    return basePrompt + stateContext;
  }

  /**
   * Call Digital Ocean RAG endpoint with system prompt + conversation context
   */
  async callRagEndpoint(
    systemPrompt: string,
    conversationHistory: RagMessage[],
    config: ChatbotConfig
  ): Promise<string> {
    const log = (msg: string) => console.log(`[ChatbotService] ${msg}`);

    const endpoint = `${config.ragBaseUrl}/api/v1/chat/completions`;

    // Prepend system prompt to messages
    const messagesWithSystem: RagMessage[] = [
      { role: "system", content: systemPrompt },
      ...conversationHistory,
    ];

    const requestBody: RagRequest = {
      messages: messagesWithSystem,
      stream: false,
      include_functions_info: true,
      include_retrieval_info: false,
      include_guardrails_info: false,
    };

    log(`Calling RAG endpoint: ${endpoint}`);
    log(`System prompt: ${systemPrompt.length} chars`);
    log(`Conversation context: ${conversationHistory.length} messages`);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.ragAccessKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      log(`RAG endpoint response status: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        const errorText = await response.text();
        log(`❌ RAG endpoint error response: ${errorText}`);
        throw new Error(`RAG endpoint returned ${response.status}: ${errorText}`);
      }

      const data: RagResponse = await response.json();

      if (!data.choices || data.choices.length === 0) {
        throw new Error("RAG endpoint returned empty choices array");
      }

      const assistantMessage = data.choices[0].message.content;

      if (!assistantMessage || assistantMessage.trim().length === 0) {
        throw new Error("RAG endpoint returned empty message content");
      }

      log(`✅ RAG response received (${assistantMessage.length} chars)`);

      return assistantMessage.trim();

    } catch (error: any) {
      log(`❌ RAG endpoint error: ${error.message}`);

      await this.storage.createSystemLog({
        level: "error",
        message: `RAG endpoint call failed: ${error.message}`,
        metadata: {
          endpoint,
          conversationLength: conversationHistory.length,
          error: error.message,
        },
      });

      throw error;
    }
  }

  /**
   * Analyze bot response to update conversation state (demo asks, user intent detection)
   */
  analyzeResponseForState(botResponse: string, state: ConversationState): Partial<ConversationState> {
    const updates: Partial<ConversationState> = {};
    const lower = botResponse.toLowerCase();

    // Detect if bot is asking for a demo
    const demoPatterns = [
      'schedule a demo', 'book a demo', 'google meet', 'quick demo',
      'live demo', 'schedule a call', 'set up a demo', 'arrange a demo',
    ];
    if (demoPatterns.some(p => lower.includes(p))) {
      updates.demoAskedCount = state.demoAskedCount + 1;
    }

    return updates;
  }

  /**
   * Detect user intent from their message
   */
  detectUserIntent(messageText: string, currentIntent: ConversationState['userIntent']): ConversationState['userIntent'] {
    const lower = messageText.toLowerCase().trim();

    const declinePatterns = ['not interested', 'no thanks', 'no thank', 'not now', 'later', 'busy', 'stop'];
    const browsingPatterns = ['just browsing', 'just looking', 'just checking', 'exploring'];
    const interestPatterns = ['interested', 'tell me more', 'how much', 'price', 'pricing', 'demo', 'show me', 'features', 'yes'];

    if (declinePatterns.some(p => lower.includes(p))) return 'declined';
    if (browsingPatterns.some(p => lower.includes(p))) return 'browsing';
    if (interestPatterns.some(p => lower.includes(p))) return 'interested';

    return currentIntent;
  }

  /**
   * Process a lead message: check cooldown, get context, call RAG with system prompt, send reply
   */
  async processLeadMessage(phoneNumber: string, messageText: string, replyToJid?: string): Promise<void> {
    const log = (msg: string) => console.log(`[ChatbotService] ${msg}`);

    try {
      log(`Processing lead message from ${phoneNumber}`);

      // Get chatbot config
      const config = await this.storage.getChatbotConfig();

      if (!config || config.isActive !== "true") {
        log(`⚠️ Chatbot not configured or inactive`);
        return;
      }

      const cooldownSeconds = (config as any).replyCooldownSeconds || 8;
      const typingDelayMs = (config as any).typingDelayMs || 2000;

      // Check reply cooldown
      if (this.isOnCooldown(phoneNumber, cooldownSeconds)) {
        const lastReply = lastReplyTimestamps.get(phoneNumber) || 0;
        const remaining = cooldownSeconds - ((Date.now() - lastReply) / 1000);
        log(`⏳ Cooldown active for ${phoneNumber} (${remaining.toFixed(1)}s remaining) — skipping reply`);
        return;
      }

      // Get and update conversation state
      const state = await this.getConversationState(phoneNumber);
      const userIntent = this.detectUserIntent(messageText, state.userIntent);

      // If user has declined, don't auto-respond unless they show renewed interest
      if (state.userIntent === 'declined' && userIntent === 'declined') {
        log(`🛑 User ${phoneNumber} has declined — not responding`);
        return;
      }

      // Update state with new intent
      await this.updateConversationState(phoneNumber, {
        userIntent,
        messageCount: state.messageCount + 1,
      });

      // Get conversation history
      const limit = config.contextMessageCount || 5;
      const history = await this.getConversationHistory(phoneNumber, limit);
      const recentHistory = await this.getConversationHistory(phoneNumber, 40);
      const voiceNoteRequested = this.isVoiceNoteRequested(messageText);
      const voiceNoteAlreadySent = this.hasSentVoiceNoteEarlier(recentHistory);
      const greetingItems = this.parseGreetingItems((config as any)?.greetingMessage || DEFAULT_GREETING);
      const hasConfiguredVoiceGreeting = greetingItems.some(item => item.kind === 'audio' || item.kind === 'audio_url');

      log(`Retrieved ${history.length} messages from conversation history`);

      // Add current message to history for context
      const fullConversation = [
        ...history,
        {
          phoneNumber,
          content: messageText,
          type: "incoming" as const,
          status: "received" as const,
          timestamp: new Date(),
        }
      ];

      // Format for RAG
      const ragMessages = this.formatConversationForRAG(fullConversation);

      // Build system prompt with state context
      const updatedState = await this.getConversationState(phoneNumber);
      const systemPrompt = this.buildSystemPrompt(config, updatedState, {
        requestedInLatestMessage: voiceNoteRequested,
        alreadySentEarlier: voiceNoteAlreadySent,
        configuredInGreeting: hasConfiguredVoiceGreeting,
      });

      // Call RAG endpoint with system prompt
      const botResponse = await this.callRagEndpoint(systemPrompt, ragMessages, config);

      // Analyze response to update state (demo ask tracking)
      const responseStateUpdates = this.analyzeResponseForState(botResponse, updatedState);
      if (Object.keys(responseStateUpdates).length > 0) {
        await this.updateConversationState(phoneNumber, responseStateUpdates);
      }

      // Extract image URL if present
      const { textMessage, imageUrl } = this.extractImageUrl(botResponse);

      // Apply typing delay to simulate natural conversation
      if (typingDelayMs > 0) {
        log(`⏳ Typing delay: ${typingDelayMs}ms`);
        await new Promise(resolve => setTimeout(resolve, typingDelayMs));
      }

      log(`Sending auto-reply to ${phoneNumber}`);

      // Send text reply via WhatsApp
      await this.whatsappService.sendTextMessage(replyToJid || phoneNumber, textMessage);

      // Record reply timestamp for cooldown
      lastReplyTimestamps.set(phoneNumber, Date.now());

      // Update conversation state with reply time
      await this.updateConversationState(phoneNumber, {
        lastBotReplyAt: new Date().toISOString(),
      });

      // Store the outgoing message in DB
      await this.storage.createMessage({
        phoneNumber,
        content: textMessage,
        type: "text",
        status: "sent",
        metadata: {
          chatbot_reply: true,
          rag_endpoint: config.ragBaseUrl,
          had_image: !!imageUrl,
          conversation_state: await this.getConversationState(phoneNumber),
        },
      });

      // If image URL found, download and send it
      if (imageUrl) {
        log(`📷 Image URL detected: ${imageUrl}`);
        await this.downloadAndSendImage(phoneNumber, imageUrl, replyToJid);
      }

      if (voiceNoteRequested && !voiceNoteAlreadySent && hasConfiguredVoiceGreeting) {
        log(`Voice note requested by ${phoneNumber}; sending configured voice note(s)`);
        await this.sendConfiguredVoiceGreetings(phoneNumber, greetingItems, replyToJid);
      }

      log(`✅ Auto-reply sent successfully`);

      // Update contact's last message time
      await this.storage.updateContact(phoneNumber, {
        lastMessageAt: new Date(),
      });

    } catch (error: any) {
      log(`❌ Error processing lead message: ${error.message}`);

      await this.storage.createSystemLog({
        level: "error",
        message: `Failed to process lead message from ${phoneNumber}: ${error.message}`,
        metadata: {
          phoneNumber,
          error: error.message,
          stack: error.stack,
        },
      });
    }
  }

  /**
   * Extract image URL from chatbot response
   * Format: "image url: [URL]" at the end of the message
   */
  private extractImageUrl(response: string): { textMessage: string; imageUrl: string | null } {
    const imageUrlPattern = /image url:\s*(.+?)$/im;
    const match = response.match(imageUrlPattern);

    if (match) {
      const imageUrl = match[1].trim();
      const textMessage = response.replace(imageUrlPattern, '').trim();
      return { textMessage, imageUrl };
    }

    return { textMessage: response, imageUrl: null };
  }

  /**
   * Download image from URL and send via WhatsApp
   */
  private async downloadAndSendImage(phoneNumber: string, imageUrl: string, replyToJid?: string): Promise<void> {
    const log = (msg: string) => console.log(`[ChatbotService] ${msg}`);

    try {
      log(`Downloading image from: ${imageUrl}`);

      // Create uploads directory if not exists
      const uploadsDir = path.join(process.cwd(), 'uploads', 'chatbot-images');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }

      // Generate filename
      const timestamp = Date.now();
      const urlObj = new URL(imageUrl);
      const extension = path.extname(urlObj.pathname) || '.jpg';
      const filename = `chatbot_${phoneNumber}_${timestamp}${extension}`;
      const filePath = path.join(uploadsDir, filename);

      // Download image
      await this.downloadFile(imageUrl, filePath);

      log(`✅ Image downloaded: ${filename}`);

      // Send via WhatsApp
      await this.whatsappService.sendMediaMessage(replyToJid || phoneNumber, filePath, 'Reference image');

      log(`✅ Image sent successfully to ${phoneNumber}`);

      // Store the image message in DB
      await this.storage.createMessage({
        phoneNumber,
        content: 'Image attachment',
        type: "image",
        status: "sent",
        fileUrl: `/uploads/chatbot-images/${filename}`,
        fileName: filename,
        metadata: {
          chatbot_reply: true,
          image_url: imageUrl,
        },
      });

      // Clean up file after 5 minutes
      setTimeout(() => {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          log(`🗑️ Cleaned up temporary image: ${filename}`);
        }
      }, 5 * 60 * 1000);

    } catch (error: any) {
      log(`❌ Failed to download/send image: ${error.message}`);

      await this.storage.createSystemLog({
        level: "error",
        message: `Failed to send image to ${phoneNumber}: ${error.message}`,
        metadata: {
          phoneNumber,
          imageUrl,
          error: error.message,
        },
      });
    }
  }

  /**
   * Download audio from URL and send as WhatsApp voice note
   */
  private async downloadAndSendAudio(phoneNumber: string, audioUrl: string, replyToJid?: string): Promise<void> {
    const log = (msg: string) => console.log(`[ChatbotService] ${msg}`);

    try {
      log(`Downloading audio from: ${audioUrl}`);

      const uploadsDir = path.join(process.cwd(), 'uploads', 'chatbot-audio');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }

      const timestamp = Date.now();
      const urlObj = new URL(audioUrl);
      const extension = path.extname(urlObj.pathname) || '.mp3';
      const filename = `chatbot_${phoneNumber}_${timestamp}${extension}`;
      const filePath = path.join(uploadsDir, filename);

      await this.downloadFile(audioUrl, filePath);
      await this.whatsappService.sendMediaMessage(replyToJid || phoneNumber, filePath);

      setTimeout(() => {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          log(`Cleaned up temporary audio: ${filename}`);
        }
      }, 5 * 60 * 1000);
    } catch (error: any) {
      log(`Failed to download/send audio: ${this.errorMessage(error)}`);
      await this.storage.createSystemLog({
        level: "error",
        message: `Failed to send audio to ${phoneNumber}: ${this.errorMessage(error)}`,
        metadata: {
          phoneNumber,
          audioUrl,
          error: this.errorMessage(error),
        },
      });
    }
  }

  private parseGreetingItems(greetingRaw: string): GreetingItem[] {
    return greetingRaw
      .split('===NEXT_MESSAGE===')
      .map((p: string) => p.trim())
      .filter((p: string) => p.length > 0)
      .map((part: string) => {
        const mediaUrlMatch = part.match(/^AUDIO_URL\s*:\s*(.+)$/i);
        if (mediaUrlMatch) {
          return {
            kind: 'audio_url' as const,
            value: mediaUrlMatch[1].trim(),
          };
        }
        const mediaMatch = part.match(/^(AUDIO|VOICE_NOTE)\s*:\s*(.+)$/i);
        if (mediaMatch) {
          const value = mediaMatch[2].trim();
          if (this.isHttpUrl(value)) {
            return {
              kind: 'audio_url' as const,
              value,
            };
          }
          return {
            kind: 'audio' as const,
            value,
          };
        }
        return {
          kind: 'text' as const,
          value: part,
        };
      });
  }

  private isVoiceNoteRequested(messageText: string): boolean {
    const lower = (messageText || '').toLowerCase();
    const patterns = [
      'voice note',
      'voicenote',
      'audio note',
      'audio msg',
      'audio message',
      'send audio',
      'voice msg',
      'send voice',
      'voice message',
      'audio bhejo',
      'voice bhejo',
      'audio send',
    ];
    return patterns.some((p) => lower.includes(p));
  }

  private hasSentVoiceNoteEarlier(messages: Message[]): boolean {
    return messages.some((m) => {
      const metadata = (m.metadata && typeof m.metadata === 'object') ? (m.metadata as any) : {};
      const byType = m.type === 'audio';
      const byContent = typeof m.content === 'string' && m.content.startsWith('[Voice Note]');
      const byMeta = metadata.greeting_kind === 'audio' || metadata.greeting_kind === 'audio_url' || metadata.chatbot_voice_followup === true;
      return byType || byContent || byMeta;
    });
  }

  private async sendConfiguredVoiceGreetings(
    phoneNumber: string,
    greetingItems: GreetingItem[],
    replyToJid?: string
  ): Promise<void> {
    const voiceItems = greetingItems.filter(item => item.kind === 'audio' || item.kind === 'audio_url');
    if (voiceItems.length === 0) return;

    for (let i = 0; i < voiceItems.length; i++) {
      const item = voiceItems[i];
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }

      if (item.kind === 'audio_url') {
        await this.downloadAndSendAudio(phoneNumber, item.value, replyToJid);
      } else {
        await this.whatsappService.sendMediaMessage(replyToJid || phoneNumber, item.value);
      }

      await this.storage.createMessage({
        phoneNumber,
        content: `[Voice Note] ${item.value}`,
        type: "audio",
        status: "sent",
        metadata: {
          chatbot_voice_followup: true,
          greeting_kind: item.kind,
          voice_part: i + 1,
          voice_total: voiceItems.length,
        },
      });
    }
  }

  private isHttpUrl(value: string): boolean {
    return /^https?:\/\//i.test((value || '').trim());
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error.trim().length > 0) return error;
    try {
      return JSON.stringify(error);
    } catch {
      return 'Unknown error';
    }
  }

  /**
   * Download file from URL to local path
   */
  private downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;

      const file = fs.createWriteStream(destPath);

      protocol.get(url, (response) => {
        // Handle redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            file.close();
            fs.unlinkSync(destPath);
            this.downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
            return;
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
          return;
        }

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve();
        });

        file.on('error', (err) => {
          fs.unlinkSync(destPath);
          reject(err);
        });
      }).on('error', (err) => {
        fs.unlinkSync(destPath);
        reject(err);
      });
    });
  }

  /**
   * Test RAG endpoint connection
   */
  async testConnection(config: ChatbotConfig): Promise<{ success: boolean; message: string }> {
    const log = (msg: string) => console.log(`[ChatbotService] ${msg}`);

    try {
      log(`Testing RAG endpoint: ${config.ragBaseUrl}`);

      const testMessages: RagMessage[] = [
        {
          role: "user",
          content: "Hello, this is a test message."
        }
      ];

      const systemPrompt = (config as any).systemPrompt || DEFAULT_SYSTEM_PROMPT;
      const response = await this.callRagEndpoint(systemPrompt, testMessages, config);

      log(`✅ Test successful, received response: ${response.substring(0, 50)}...`);

      return {
        success: true,
        message: `Connection successful! Response: ${response.substring(0, 100)}...`
      };

    } catch (error: any) {
      log(`❌ Test failed: ${error.message}`);

      return {
        success: false,
        message: `Connection failed: ${error.message}`
      };
    }
  }
}

