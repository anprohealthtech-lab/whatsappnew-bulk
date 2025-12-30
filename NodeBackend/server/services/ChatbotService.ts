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
 * - Downloads and sends images from URLs provided by chatbot
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
   * Flag a phone number as a lead and send initial greeting
   */
  async flagAsLead(phoneNumber: string, keyword: string, name?: string): Promise<Contact> {
    const log = (msg: string) => console.log(`[ChatbotService] ${msg}`);
    
    log(`Flagging ${phoneNumber} as lead (trigger: "${keyword}")`);
    
    const contact = await this.storage.flagAsLead(phoneNumber, keyword, name);
    
    log(`✅ ${phoneNumber} flagged as lead`);
    
    // Send initial greeting message
    try {
      const greetingMessage = "Hello! 👋 Welcome to AnPro Solutions. I'm excited to hear you're interested in a Laboratory Information Management System (LIMS).\n\nOur AI-powered LIMS is designed to transform how pathology labs operate 🚀 Would you like to tell me a bit about your lab? What specific challenges are you looking to solve with a new LIMS? The more I know, the better I can show you how AnPro can help streamline your operations.";
      
      log(`Sending greeting message to new lead ${phoneNumber}`);
      await this.whatsappService.sendTextMessage(phoneNumber, greetingMessage);
      
      // Store the greeting message in DB
      await this.storage.createMessage({
        phoneNumber,
        content: greetingMessage,
        type: "text",
        status: "sent",
        metadata: {
          chatbot_greeting: true,
          trigger_keyword: keyword,
        },
      });
      
      log(`✅ Greeting message sent to ${phoneNumber}`);
    } catch (error: any) {
      log(`⚠️ Failed to send greeting message: ${error.message}`);
      // Don't throw - lead is still flagged even if greeting fails
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
    log(`Access key: ${config.ragAccessKey ? config.ragAccessKey.substring(0, 3) + '...' : 'NOT SET'}`);

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

      // Get conversation history (excluding the current message which isn't stored yet)
      const limit = config.contextMessageCount || 3;
      const history = await this.getConversationHistory(phoneNumber, limit);

      log(`Retrieved ${history.length} messages from conversation history`);

      // Add current message to history for context
      const fullConversation = [
        ...history,
        {
          phoneNumber,
          content: messageText,
          type: "incoming" as const, // incoming = from user/lead
          status: "received" as const,
          timestamp: new Date(),
        }
      ];

      // Format for RAG
      const ragMessages = this.formatConversationForRAG(fullConversation);

      // Call RAG endpoint
      const botResponse = await this.callRagEndpoint(ragMessages, config);

      // Extract image URL if present
      const { textMessage, imageUrl } = this.extractImageUrl(botResponse);

      log(`Sending auto-reply to ${phoneNumber}`);

      // Send text reply via WhatsApp
      await this.whatsappService.sendTextMessage(phoneNumber, textMessage);

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
        },
      });

      // If image URL found, download and send it
      if (imageUrl) {
        log(`📷 Image URL detected: ${imageUrl}`);
        await this.downloadAndSendImage(phoneNumber, imageUrl);
      }

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
  private async downloadAndSendImage(phoneNumber: string, imageUrl: string): Promise<void> {
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
      await this.whatsappService.sendMediaMessage(phoneNumber, filePath, 'Reference image');

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
