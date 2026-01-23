/**
 * HRChatbotService - Personal WhatsApp Assistant with Anthropic Claude
 * 
 * This service handles WhatsApp messages and uses Anthropic Claude with
 * native tool calling for creating tasks, checking attendance, and more.
 * 
 * Architecture:
 * 1. WhatsApp message → WhatsApp Backend (this service)
 * 2. This service → Anthropic Claude API (with tool definitions)
 * 3. Claude returns tool_use blocks → This service executes via DO Functions
 * 4. Results sent back to Claude for final response formatting
 * 5. Final response sent via WhatsApp
 * 
 * Features:
 * - Natural conversation for creating reminders
 * - Recurring reminders (daily, weekly, monthly)
 * - Delete/cancel reminders
 * - Team attendance check-in
 * - Find team members
 * 
 * Personality: Warm, helpful, brief—like a smart friend who never forgets
 */

import Anthropic from "@anthropic-ai/sdk";
import type { IStorage } from "../storage";
import type { HRAdmin, HRChatbotConfig, Message } from "@shared/schema";

// DO Functions base URL (can be overridden via env)
const DO_FUNCTIONS_BASE = process.env.DO_FUNCTIONS_BASE_URL || "https://faas-blr1-8177d592.doserverless.co/api/v1/web/fn-90be8014-1769-44c7-8b81-46179614f63a/default";

// System prompt for Claude
const SYSTEM_PROMPT = `You are a friendly personal assistant that lives in WhatsApp. You're like a second brain that never forgets. You help people remember things, stay organized, and manage their daily tasks through natural conversation.

## YOUR IDENTITY
- Personality: Warm, helpful, slightly witty—like a smart friend who has their life together
- Platform: WhatsApp
- Tone: Casual and friendly, use emojis naturally 😊
- Language: Short, conversational, mobile-friendly

## YOUR CORE BELIEF
"You've built a life around remembering everything. That's why you're exhausted."
Your job is to remember things so the user doesn't have to.

## YOUR CAPABILITIES
You have access to tools for:
1. Creating tasks and reminders (one-time or recurring)
2. Deleting tasks
3. Checking team attendance
4. Finding team members

## RESPONSE STYLE
Be conversational and warm. You're a friend, not a robot.
- Be brief - This is WhatsApp, not email
- Be warm - "Got it!" not "Task created successfully"
- Be smart - Understand context, don't ask obvious questions
- Use emojis naturally - But don't overdo it
- Confirm clearly - They should know what you understood

## DATE HANDLING
Convert natural language dates to YYYY-MM-DD format:
- "tomorrow" → next day
- "next Monday" → calculate it
- "end of month" → last day of current month
- "in 3 days" → add 3 days
- "Friday" → this coming Friday
- "the 15th" → 15th of current month (or next if passed)

## IMPORTANT RULES
1. ALWAYS use the provided userId and organizationId in function calls
2. For self-reminders, use userId as assigneeId
3. When assigning to others, first use get_users to find their ID
4. Be concise - WhatsApp messages should be short
5. Use formatting - *bold* for headings, • for bullets`;

// Tool definitions for Anthropic
const TOOLS: Anthropic.Tool[] = [
  {
    name: "create_task",
    description: "Create a task or reminder. For self-reminders use userId as assigneeId. For team tasks, first call get_users to find the assignee's ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        userId: {
          type: "string",
          description: "The ID of the user creating the task (from context)"
        },
        organizationId: {
          type: "string",
          description: "The organization ID (from context)"
        },
        title: {
          type: "string",
          description: "Clear, actionable task title"
        },
        description: {
          type: "string",
          description: "Additional details about the task"
        },
        assigneeId: {
          type: "string",
          description: "User ID to assign to. Use userId for self-reminders"
        },
        priority: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Priority level. Default: medium"
        },
        dueDate: {
          type: "string",
          description: "Due date in YYYY-MM-DD format"
        },
        type: {
          type: "string",
          description: "Task type: Advisory, Reporting, Follow-up, etc. Default: Advisory"
        }
      },
      required: ["userId", "organizationId", "title"]
    }
  },
  {
    name: "create_recurring_task",
    description: "Create a recurring task that repeats. Use when user says 'remind me daily/weekly/monthly' or wants something that repeats.",
    input_schema: {
      type: "object" as const,
      properties: {
        userId: {
          type: "string",
          description: "The ID of the user creating the task"
        },
        organizationId: {
          type: "string",
          description: "The organization ID"
        },
        title: {
          type: "string",
          description: "Clear, actionable task title"
        },
        recurrenceFrequency: {
          type: "string",
          enum: ["daily", "weekly", "monthly", "quarterly", "6monthly", "yearly"],
          description: "How often the task repeats"
        },
        description: {
          type: "string",
          description: "Additional details"
        },
        assigneeId: {
          type: "string",
          description: "User ID to assign to"
        },
        priority: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Priority level"
        },
        startDate: {
          type: "string",
          description: "Start date in YYYY-MM-DD format"
        }
      },
      required: ["userId", "organizationId", "title", "recurrenceFrequency"]
    }
  },
  {
    name: "delete_task",
    description: "Delete a task by ID or title. User can only delete tasks they created or assigned to them.",
    input_schema: {
      type: "object" as const,
      properties: {
        userId: {
          type: "string",
          description: "The user deleting the task"
        },
        organizationId: {
          type: "string",
          description: "The organization ID"
        },
        taskId: {
          type: "string",
          description: "Specific task ID to delete"
        },
        taskTitle: {
          type: "string",
          description: "Search for task by title (partial match)"
        }
      },
      required: ["userId", "organizationId"]
    }
  },
  {
    name: "get_attendance",
    description: "Get attendance report. Returns who is present, absent, late, or left early.",
    input_schema: {
      type: "object" as const,
      properties: {
        organizationId: {
          type: "string",
          description: "The organization ID"
        },
        date: {
          type: "string",
          description: "Date in YYYY-MM-DD format. Defaults to today"
        }
      },
      required: ["organizationId"]
    }
  },
  {
    name: "get_users",
    description: "Search for team members. Use to find user IDs before assigning tasks.",
    input_schema: {
      type: "object" as const,
      properties: {
        organizationId: {
          type: "string",
          description: "The organization ID"
        },
        searchQuery: {
          type: "string",
          description: "Search by name or email"
        },
        department: {
          type: "string",
          description: "Filter by department"
        }
      },
      required: ["organizationId"]
    }
  }
];

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

// In-memory conversation cache (per phone number, last 10 messages)
const conversationCache = new Map<string, ConversationMessage[]>();
const MAX_CONVERSATION_HISTORY = 10;

export class HRChatbotService {
  private anthropic: Anthropic | null = null;

  constructor(
    private storage: IStorage,
    private whatsappService: any
  ) {
    // Initialize Anthropic client if API key is available
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.anthropic = new Anthropic({ apiKey });
      console.log("[HRChatbotService] Anthropic client initialized");
    } else {
      console.warn("[HRChatbotService] ANTHROPIC_API_KEY not set - chatbot will not work");
    }
  }

  /**
   * Check if phone number is a registered HR admin
   */
  async isHRAdmin(phoneNumber: string): Promise<boolean> {
    const hrAdmin = await this.storage.getHRAdmin(phoneNumber);
    return !!hrAdmin;
  }

  /**
   * Get HR admin details for a phone number
   */
  async getHRAdmin(phoneNumber: string): Promise<HRAdmin | null> {
    return await this.storage.getHRAdmin(phoneNumber) || null;
  }

  /**
   * Check if HR chatbot is active for this admin
   */
  async isHRChatbotActive(phoneNumber: string): Promise<boolean> {
    const hrAdmin = await this.storage.getHRAdmin(phoneNumber);
    return hrAdmin?.chatbotActive === "true";
  }

  /**
   * Get conversation history from cache
   */
  private getConversationFromCache(phoneNumber: string): ConversationMessage[] {
    return conversationCache.get(phoneNumber) || [];
  }

  /**
   * Add message to conversation cache
   */
  private addToConversationCache(phoneNumber: string, role: "user" | "assistant", content: string): void {
    const history = this.getConversationFromCache(phoneNumber);
    history.push({ role, content });
    
    // Keep only last N messages
    if (history.length > MAX_CONVERSATION_HISTORY) {
      history.shift();
    }
    
    conversationCache.set(phoneNumber, history);
  }

  /**
   * Call DO Serverless Function directly
   */
  private async callDOFunction(
    functionName: string,
    params: Record<string, any>
  ): Promise<any> {
    const log = (msg: string) => console.log(`[HRChatbotService] ${msg}`);
    
    // Build URL with query params (DO Functions use GET with query params)
    const url = new URL(`${DO_FUNCTIONS_BASE}/${functionName}`);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });

    log(`📡 Calling DO Function: ${functionName}`);
    log(`   URL: ${url.toString().substring(0, 100)}...`);

    try {
      const response = await fetch(url.toString(), { method: "GET" });
      const data = await response.json();
      
      log(`   Response: ${JSON.stringify(data).substring(0, 150)}...`);
      return data;
    } catch (error: any) {
      log(`❌ DO Function error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute a tool call from Claude
   */
  private async executeTool(
    toolName: string,
    toolInput: Record<string, any>,
    hrAdmin: HRAdmin
  ): Promise<string> {
    const log = (msg: string) => console.log(`[HRChatbotService] ${msg}`);
    
    log(`🔧 Executing tool: ${toolName}`);
    log(`   Input: ${JSON.stringify(toolInput)}`);

    // Merge toolInput with defaults from hrAdmin
    const userId = toolInput.userId || hrAdmin.userId;
    const organizationId = toolInput.organizationId || hrAdmin.organizationId;

    try {
      switch (toolName) {
        case "create_task": {
          const result = await this.callDOFunction("create-task", {
            ...toolInput,
            userId,
            organizationId
          });
          if (result.success) {
            const task = result.data?.task;
            return JSON.stringify({
              success: true,
              task: {
                id: task?.id,
                title: task?.title,
                dueDate: task?.due_date,
                priority: task?.priority,
                assignedTo: task?.assigned_to_name
              }
            });
          }
          return JSON.stringify({ success: false, error: result.error || "Failed to create task" });
        }

        case "create_recurring_task": {
          const recurrenceFrequency = toolInput.recurrenceFrequency;
          const result = await this.callDOFunction("create-recurring-task", {
            ...toolInput,
            userId,
            organizationId,
            recurrencePattern: recurrenceFrequency
          });
          if (result.success) {
            return JSON.stringify({
              success: true,
              template: result.data?.template,
              frequency: recurrenceFrequency
            });
          }
          return JSON.stringify({ success: false, error: result.error || "Failed to create recurring task" });
        }

        case "delete_task": {
          const result = await this.callDOFunction("delete-task", {
            ...toolInput,
            userId,
            organizationId
          });
          if (result.success) {
            return JSON.stringify({
              success: true,
              deletedTask: result.data?.deleted_task?.title
            });
          }
          return JSON.stringify({ success: false, error: result.error || "Task not found" });
        }

        case "get_attendance": {
          const result = await this.callDOFunction("get-attendance", {
            organizationId,
            date: toolInput.date || new Date().toISOString().split('T')[0]
          });
          if (result.success) {
            const data = result.data;
            return JSON.stringify({
              success: true,
              date: data.date,
              statistics: data.statistics,
              present: data.present?.map((u: any) => ({ name: u.name, punchIn: u.punch_in_time })),
              absent: data.absent?.map((u: any) => ({ name: u.name, department: u.department })),
              late: data.late?.map((u: any) => ({ name: u.name, punchIn: u.punch_in_time }))
            });
          }
          return JSON.stringify({ success: false, error: result.error || "Failed to get attendance" });
        }

        case "get_users": {
          const result = await this.callDOFunction("get-users", {
            organizationId,
            searchQuery: toolInput.searchQuery,
            department: toolInput.department
          });
          if (result.success) {
            const users = result.data?.users || [];
            return JSON.stringify({
              success: true,
              count: users.length,
              users: users.slice(0, 10).map((u: any) => ({
                id: u.id,
                name: u.name,
                department: u.department,
                email: u.email
              }))
            });
          }
          return JSON.stringify({ success: false, error: result.error || "Failed to get users" });
        }

        default:
          return JSON.stringify({ success: false, error: `Unknown tool: ${toolName}` });
      }
    } catch (error: any) {
      log(`❌ Tool execution error: ${error.message}`);
      return JSON.stringify({ success: false, error: error.message });
    }
  }

  /**
   * Process message with Anthropic Claude
   */
  private async processWithClaude(
    userMessage: string,
    hrAdmin: HRAdmin,
    conversationHistory: ConversationMessage[]
  ): Promise<string> {
    const log = (msg: string) => console.log(`[HRChatbotService] ${msg}`);

    if (!this.anthropic) {
      throw new Error("Anthropic client not initialized - check ANTHROPIC_API_KEY");
    }

    // Build context for system prompt
    const contextInfo = `
## CURRENT CONTEXT
- User Name: ${hrAdmin.name || 'User'}
- User ID: ${hrAdmin.userId}
- Organization ID: ${hrAdmin.organizationId}
- Organization: ${hrAdmin.organizationName || 'the organization'}
- Current Date: ${new Date().toISOString().split('T')[0]}
- Current Time: ${new Date().toLocaleTimeString()}

IMPORTANT: Always use userId="${hrAdmin.userId}" and organizationId="${hrAdmin.organizationId}" in ALL function calls.`;

    const fullSystemPrompt = SYSTEM_PROMPT + contextInfo;

    // Build messages array
    const messages: Anthropic.MessageParam[] = [
      ...conversationHistory.map(msg => ({
        role: msg.role as "user" | "assistant",
        content: msg.content
      })),
      { role: "user", content: userMessage }
    ];

    log(`📡 Calling Anthropic Claude`);
    log(`   User: ${hrAdmin.name} (${hrAdmin.phoneNumber})`);
    log(`   Message: ${userMessage.substring(0, 50)}...`);
    log(`   History: ${conversationHistory.length} messages`);

    try {
      // Initial API call
      let response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: fullSystemPrompt,
        tools: TOOLS,
        messages
      });

      log(`   Stop reason: ${response.stop_reason}`);

      // Handle tool use loop
      while (response.stop_reason === "tool_use") {
        const toolUseBlocks = response.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
        );

        log(`🔧 Claude wants to use ${toolUseBlocks.length} tool(s)`);

        // Execute each tool
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        
        for (const toolUse of toolUseBlocks) {
          log(`   Tool: ${toolUse.name}`);
          const result = await this.executeTool(
            toolUse.name,
            toolUse.input as Record<string, any>,
            hrAdmin
          );
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result
          });
        }

        // Continue conversation with tool results
        const updatedMessages: Anthropic.MessageParam[] = [
          ...messages,
          { role: "assistant", content: response.content },
          { role: "user", content: toolResults }
        ];

        response = await this.anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          system: fullSystemPrompt,
          tools: TOOLS,
          messages: updatedMessages
        });

        log(`   Continued - Stop reason: ${response.stop_reason}`);
      }

      // Extract final text response
      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === "text"
      );

      const finalResponse = textBlocks.map(b => b.text).join("\n").trim();
      
      log(`📤 Final response: ${finalResponse.substring(0, 100)}...`);
      
      return finalResponse || "Done! ✅";

    } catch (error: any) {
      log(`❌ Anthropic API error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Process an HR admin message
   */
  async processHRMessage(phoneNumber: string, messageText: string): Promise<void> {
    const log = (msg: string) => console.log(`[HRChatbotService] ${msg}`);
    
    try {
      log(`📥 Processing HR message from ${phoneNumber}`);

      // Get HR admin details
      const hrAdmin = await this.storage.getHRAdmin(phoneNumber);
      
      if (!hrAdmin) {
        log(`⚠️ No HR admin found for ${phoneNumber}`);
        return;
      }

      // Check if chatbot is active for this admin
      if (hrAdmin.chatbotActive !== "true") {
        log(`⏸️ HR Chatbot paused for ${phoneNumber}`);
        return;
      }

      // Get conversation history from cache
      const history = this.getConversationFromCache(phoneNumber);

      log(`   Retrieved ${history.length} messages from cache`);

      // Add user message to cache
      this.addToConversationCache(phoneNumber, "user", messageText);

      // Process with Claude
      const botResponse = await this.processWithClaude(messageText, hrAdmin, history);

      // Add assistant response to cache
      this.addToConversationCache(phoneNumber, "assistant", botResponse);

      log(`📤 Sending response to ${phoneNumber}`);

      // Send reply via WhatsApp
      await this.whatsappService.sendTextMessage(phoneNumber, botResponse);

      // Store outgoing message
      await this.storage.createMessage({
        phoneNumber,
        content: botResponse,
        type: "text",
        status: "sent",
        metadata: {
          hr_chatbot_reply: true,
          organization_id: hrAdmin.organizationId,
        },
      });

      log(`✅ HR response sent successfully`);

      // Update HR admin last message time
      await this.storage.updateHRAdmin(phoneNumber, {
        updatedAt: new Date(),
      });

    } catch (error: any) {
      log(`❌ Error processing HR message: ${error.message}`);
      
      await this.storage.createSystemLog({
        level: "error",
        message: `Failed to process HR message from ${phoneNumber}: ${error.message}`,
        metadata: {
          phoneNumber,
          error: error.message,
          stack: error.stack,
        },
      });

      // Send fallback message
      try {
        await this.whatsappService.sendTextMessage(
          phoneNumber,
          "Oops, something went wrong on my end 😅\n\nMind trying that again?"
        );
      } catch (e) {
        log(`❌ Failed to send fallback message: ${e}`);
      }
    }
  }

  /**
   * Send welcome message to new user
   */
  async sendWelcomeMessage(hrAdmin: HRAdmin): Promise<void> {
    const log = (msg: string) => console.log(`[HRChatbotService] ${msg}`);
    
    try {
      const welcomeMessage = `Hey ${hrAdmin.name?.split(' ')[0] || 'there'}! 👋

I'm your personal assistant on WhatsApp—think of me as your second brain that never forgets.

Here's what I can do for you:

📋 *Reminders & Tasks*
"Remind me to call the bank tomorrow"
"Create task for Priyanka: review report"

🔁 *Recurring Reminders*
"Remind me daily to check emails"
"Every Monday: review expenses"

👥 *Manage Your Team*
"Who's in today?"
"Find Priyanka"
"Assign task to Rahul"

🗑️ *Delete Anything*
"Delete my reminder about..."
"Cancel the meeting task"

Just talk to me naturally—I'll handle the rest! 🚀

What can I help you with?`;

      await this.whatsappService.sendTextMessage(hrAdmin.phoneNumber, welcomeMessage);

      // Store welcome message
      await this.storage.createMessage({
        phoneNumber: hrAdmin.phoneNumber,
        content: welcomeMessage,
        type: "text",
        status: "sent",
        metadata: {
          welcome_message: true,
          organization_id: hrAdmin.organizationId,
        },
      });

      log(`✅ Welcome message sent to ${hrAdmin.phoneNumber}`);

    } catch (error: any) {
      log(`❌ Failed to send welcome message: ${error.message}`);
    }
  }

  /**
   * Test connection - now tests Anthropic API
   */
  async testConnection(config: HRChatbotConfig): Promise<{ success: boolean; message: string }> {
    const log = (msg: string) => console.log(`[HRChatbotService] ${msg}`);
    
    try {
      log(`🧪 Testing Anthropic connection`);

      if (!this.anthropic) {
        return {
          success: false,
          message: "Anthropic client not initialized - check ANTHROPIC_API_KEY"
        };
      }

      // Simple test call
      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        messages: [{ role: "user", content: "Say 'Hello! Connection successful.' in exactly those words." }]
      });

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map(b => b.text)
        .join("");

      log(`✅ Test successful: ${text}`);

      return {
        success: true,
        message: `Anthropic connection successful! Response: ${text}`
      };

    } catch (error: any) {
      log(`❌ Test failed: ${error.message}`);
      return {
        success: false,
        message: `Connection failed: ${error.message}`
      };
    }
  }

  /**
   * Legacy method - kept for compatibility
   */
  async getConversationHistory(phoneNumber: string, limit: number = 5): Promise<Message[]> {
    const messages = await this.storage.getConversationHistory(phoneNumber, limit);
    return messages.reverse();
  }

  /**
   * Legacy method - kept for compatibility  
   */
  formatConversationForRAG(messages: Array<{ content: string; type: string }>): any[] {
    return messages.map(msg => ({
      role: msg.type === "incoming" ? "user" : "assistant",
      content: msg.content
    }));
  }

  /**
   * Legacy method - call RAG endpoint (redirects to processWithClaude)
   */
  async callRagEndpoint(
    conversationHistory: any[],
    config: HRChatbotConfig,
    hrAdmin: HRAdmin
  ): Promise<string> {
    const lastUserMessage = conversationHistory.filter(m => m.role === "user").pop();
    if (!lastUserMessage) {
      return "Hey! 👋 What can I help you with?";
    }

    const history = conversationHistory.slice(0, -1).map(m => ({
      role: m.role as "user" | "assistant",
      content: m.content
    }));

    return this.processWithClaude(lastUserMessage.content, hrAdmin, history);
  }
}
