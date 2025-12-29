/**
 * ChatbotService - Manages lead detection and RAG chatbot integration
 * 
 * Features:
 * - Detects lead trigger keywords (exact match, case-insensitive)
 * - Flags contacts as leads
 * - Retrieves conversation history
 * - Calls Digital Ocean RAG endpoint with conversation context
 * - Formats messages in OpenAI-compatible format
 * - Auto-replies to leads via WhatsApp
 */

import type { IStorage } from "../storage";
import type { ChatbotConfig, Contact, Message } from "@shared/schema";

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

export class ChatbotService {
  constructor(
    private storage: IStorage,
    private whatsappService: any // Will be typed properly when integrated
  ) {}

  /**
   * Detect if message text matches any configured trigger keyword (exact match, case-insensitive)
   */
  async detectLeadTrigger(messageText: string): Promise<string | null> {
    const config = await this.storage.getChatbotConfig();
    
    if (!config || config.isActive !== "true") {
      return null;
    }

    const keywords = (config.triggerKeywords as string[]) || [];
    const normalizedMessage = messageText.trim().toLowerCase();

    for (const keyword of keywords) {
      const normalizedKeyword = keyword.trim().toLowerCase();
      if (normalizedMessage === normalizedKeyword) {
        return keyword; // Return the original keyword (not normalized)
      }
    }

    return null;
  }

  /**
   * Flag a phone number as a lead
   */
  async flagAsLead(phoneNumber: string, keyword: string, name?: string): Promise<Contact> {
    const log = (msg: string) => console.log(`[ChatbotService] ${msg}`);
    
    log(`Flagging ${phoneNumber} as lead (trigger: "${keyword}")`);
    
    const contact = await this.storage.flagAsLead(phoneNumber, keyword, name);
    
    log(`✅ ${phoneNumber} flagged as lead`);
    
    return contact;
  }

  /**
   * Check if a phone number is already a lead
   */
  async isLead(phoneNumber: string): Promise<boolean> {
    return await this.storage.isLead(phoneNumber);
  }

  /**
   * Get conversation history for a phone number
   * Returns messages ordered chronologically (oldest first)
   */
  async getConversationHistory(phoneNumber: string, limit: number = 3): Promise<Message[]> {
    const messages = await this.storage.getConversationHistory(phoneNumber, limit);
    
    // Reverse to get chronological order (oldest first)
    return messages.reverse();
  }

  /**
   * Format conversation history into OpenAI-compatible message format
   * Maps: incoming (from lead) -> role: "user", outgoing (from bot) -> role: "assistant"
   */
  formatConversationForRAG(messages: Message[]): RagMessage[] {
    return messages.map(msg => {
      // Determine role based on message type
      // incoming = from lead = user
      // text = from system/bot = assistant
      const role = msg.type === "incoming" ? "user" : "assistant";
      
      return {
        role,
        content: msg.content
      };
    });
  }

  /**
   * Call Digital Ocean RAG endpoint with conversation context
   */
  async callRagEndpoint(
    conversationHistory: RagMessage[],
    config: ChatbotConfig
  ): Promise<string> {
    const log = (msg: string) => console.log(`[ChatbotService] ${msg}`);
    
    const endpoint = `${config.ragBaseUrl}/api/v1/chat/completions`;
    
    const requestBody: RagRequest = {
      messages: conversationHistory,
      stream: false,
      include_functions_info: true,
      include_retrieval_info: false,
      include_guardrails_info: false,
    };

    log(`Calling RAG endpoint: ${endpoint}`);
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

      if (!response.ok) {
        const errorText = await response.text();
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
      
      // Log to system logs
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
   * Process a lead message: get context, call RAG, send reply
   */
  async processLeadMessage(phoneNumber: string, messageText: string): Promise<void> {
    const log = (msg: string) => console.log(`[ChatbotService] ${msg}`);
    
    try {
      log(`Processing lead message from ${phoneNumber}`);

      // Get chatbot config
      const config = await this.storage.getChatbotConfig();
      
      if (!config || config.isActive !== "true") {
        log(`⚠️ Chatbot not configured or inactive`);
        return;
      }

      // Get conversation history (including the current message)
      const limit = config.contextMessageCount || 3;
      const history = await this.getConversationHistory(phoneNumber, limit);

      log(`Retrieved ${history.length} messages from conversation history`);

      // Format for RAG
      const ragMessages = this.formatConversationForRAG(history);

      // Call RAG endpoint
      const botResponse = await this.callRagEndpoint(ragMessages, config);

      log(`Sending auto-reply to ${phoneNumber}`);

      // Send reply via WhatsApp
      await this.whatsappService.sendMessage(phoneNumber, botResponse);

      // Store the outgoing message in DB
      await this.storage.createMessage({
        phoneNumber,
        content: botResponse,
        type: "text",
        status: "sent",
        metadata: {
          chatbot_reply: true,
          rag_endpoint: config.ragBaseUrl,
        },
      });

      log(`✅ Auto-reply sent successfully`);

      // Update contact's last message time
      await this.storage.updateContact(phoneNumber, {
        lastMessageAt: new Date(),
      });

    } catch (error: any) {
      log(`❌ Error processing lead message: ${error.message}`);
      
      // Log error
      await this.storage.createSystemLog({
        level: "error",
        message: `Failed to process lead message from ${phoneNumber}: ${error.message}`,
        metadata: {
          phoneNumber,
          error: error.message,
          stack: error.stack,
        },
      });

      // Optionally send fallback message
      // await this.whatsappService.sendMessage(
      //   phoneNumber,
      //   "Sorry, I'm having trouble processing your message right now. Please try again later."
      // );
    }
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

      const response = await this.callRagEndpoint(testMessages, config);

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
