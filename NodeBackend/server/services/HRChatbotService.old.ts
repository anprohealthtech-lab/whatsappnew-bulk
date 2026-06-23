/**
 * HRChatbotService - Personal WhatsApp Assistant
 * 
 * This service handles WhatsApp messages and routes them to a DigitalOcean AI Agent
 * that acts as a personal assistant / "second brain" that helps users remember things,
 * stay organized, and manage their daily tasks through natural conversation.
 * 
 * Architecture:
 * 1. WhatsApp message → WhatsApp Backend (this service)
 * 2. This service → DigitalOcean AI Agent (conversational AI)
 * 3. AI Agent returns function calls → This service executes via Supabase Edge Functions
 * 4. Results formatted in a friendly way and sent back via WhatsApp
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

import type { IStorage } from "../storage";
import type { HRAdmin, HRChatbotConfig, Message } from "@shared/schema";

interface RagMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface FunctionDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

interface RagRequest {
  messages: RagMessage[];
  stream: boolean;
  include_functions_info: boolean;
  include_retrieval_info?: boolean;
  include_guardrails_info?: boolean;
  // For function calling support
  tools?: Array<{
    type: "function";
    function: FunctionDefinition;
  }>;
}

interface FunctionCall {
  name: string;
  arguments: string; // JSON string
}

interface RagResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: FunctionCall;
      }>;
    };
    finish_reason: string;
  }>;
}

// Define available functions for the HR Agent
const HR_FUNCTIONS: Array<{ type: "function"; function: FunctionDefinition }> = [
  {
    type: "function",
    function: {
      name: "create_task",
      description: "Create a new task in the Task Management system. Use this when user wants to create a task, reminder, or todo item.",
      parameters: {
        type: "object",
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
            description: "The title/name of the task"
          },
          description: {
            type: "string",
            description: "Detailed description of the task"
          },
          assigneeId: {
            type: "string",
            description: "User ID to assign task to. Use userId for self-reminders"
          },
          priority: {
            type: "string",
            enum: ["high", "medium", "low"],
            description: "Priority level of the task. Default: medium"
          },
          dueDate: {
            type: "string",
            description: "Due date in YYYY-MM-DD format"
          },
          type: {
            type: "string",
            description: "Task type: Advisory, Reporting, Follow-up, Collection, Registration, Discharge, Investigation"
          }
        },
        required: ["userId", "organizationId", "title"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_recurring_task",
      description: "Create a recurring task that repeats. Use when user says 'remind me daily/weekly/monthly' or wants something that repeats.",
      parameters: {
        type: "object",
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
          type: {
            type: "string",
            description: "Task type: Advisory, Follow-up, Personal, Round. Default: Personal"
          },
          startDate: {
            type: "string",
            description: "Start date in YYYY-MM-DD format. Defaults to today"
          }
        },
        required: ["userId", "organizationId", "title", "recurrenceFrequency"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description: "Delete a task by ID or title. User can only delete tasks they created or assigned to them.",
      parameters: {
        type: "object",
        properties: {
          userId: {
            type: "string",
            description: "The ID of the user deleting the task"
          },
          organizationId: {
            type: "string",
            description: "The organization ID"
          },
          taskId: {
            type: "string",
            description: "Specific task ID to delete. Use this OR taskTitle"
          },
          taskTitle: {
            type: "string",
            description: "Search for task by title (partial match). Use this OR taskId"
          }
        },
        required: ["userId", "organizationId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_attendance",
      description: "Get attendance report for the organization. Shows who is present, absent, late, or left early.",
      parameters: {
        type: "object",
        properties: {
          organizationId: {
            type: "string",
            description: "The organization ID (from context)"
          },
          date: {
            type: "string",
            description: "Date for attendance report in YYYY-MM-DD format. Defaults to today if not specified."
          }
        },
        required: ["organizationId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_users",
      description: "Search or list users/employees in the organization. Use this to find people for task assignment or check team members.",
      parameters: {
        type: "object",
        properties: {
          organizationId: {
            type: "string",
            description: "The organization ID (from context)"
          },
          searchQuery: {
            type: "string",
            description: "Name or email to search for"
          },
          role: {
            type: "string",
            enum: ["user", "admin", "superadmin"],
            description: "Filter by user role"
          },
          department: {
            type: "string",
            description: "Filter by department name"
          }
        },
        required: ["organizationId"]
      }
    }
  }
];

export class HRChatbotService {
  constructor(
    private storage: IStorage,
    private whatsappService: any
  ) {}

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
   * Get conversation history for HR admin
   */
  async getConversationHistory(phoneNumber: string, limit: number = 5): Promise<Message[]> {
    const messages = await this.storage.getConversationHistory(phoneNumber, limit);
    return messages.reverse(); // Chronological order
  }

  /**
   * Format conversation for RAG
   */
  formatConversationForRAG(messages: Array<{ content: string; type: string }>): RagMessage[] {
    return messages.map(msg => ({
      role: msg.type === "incoming" ? "user" : "assistant",
      content: msg.content
    }));
  }

  /**
   * Call Supabase Edge Function
   */
  private async callEdgeFunction(
    functionName: string,
    payload: Record<string, any>,
    config: HRChatbotConfig
  ): Promise<any> {
    const log = (msg: string) => console.log(`[HRChatbotService] ${msg}`);
    
    const url = `${config.supabaseUrl}/functions/v1/${functionName}`;
    
    log(`📡 Calling edge function: ${functionName}`);
    log(`   URL: ${url}`);
    log(`   Payload: ${JSON.stringify(payload)}`);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.supabaseServiceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      
      log(`   Response status: ${response.status}`);
      log(`   Response: ${JSON.stringify(data).substring(0, 200)}...`);

      if (!response.ok) {
        throw new Error(data.error || `Edge function returned ${response.status}`);
      }

      return data;
    } catch (error: any) {
      log(`❌ Edge function error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute a function call from the AI agent
   */
  private async executeFunction(
    functionName: string,
    args: Record<string, any>,
    hrAdmin: HRAdmin,
    config: HRChatbotConfig
  ): Promise<string> {
    const log = (msg: string) => console.log(`[HRChatbotService] ${msg}`);
    
    log(`🔧 Executing function: ${functionName}`);
    log(`   Args: ${JSON.stringify(args)}`);
    
    try {
      switch (functionName) {
        case "create_task": {
          // Parse relative dates
          let dueDate = args.dueDate || args.due_date;
          if (dueDate) {
            dueDate = this.parseRelativeDate(dueDate);
          }

          const taskResult = await this.callEdgeFunction("whatsapp-create-task", {
            userId: args.userId || hrAdmin.userId,
            organizationId: args.organizationId || hrAdmin.organizationId,
            title: args.title,
            description: args.description,
            assigneeId: args.assigneeId || args.userId || hrAdmin.userId,
            priority: args.priority || "medium",
            dueDate: dueDate,
            type: args.type || "Advisory"
          }, config);

          if (taskResult.success) {
            const task = taskResult.data?.task || taskResult.data;
            let response = `✅ Got it! I'll remind you.\n\n📋 ${task.title}`;
            if (task.due_date) {
              response += `\n📅 ${new Date(task.due_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
            }
            if (task.priority === 'high') {
              response += `\n🔴 Marked as important`;
            }
            if (task.assigned_to_name && task.assigned_to_name !== hrAdmin.name) {
              response += `\n👤 Assigned to: ${task.assigned_to_name}`;
            }
            return response;
          } else {
            return `Hmm, that didn't work. ${taskResult.error}\n\nMind trying again? 🙏`;
          }
        }

        case "create_recurring_task": {
          // Parse relative dates
          let startDate = args.startDate;
          if (startDate) {
            startDate = this.parseRelativeDate(startDate);
          }

          const recurringResult = await this.callEdgeFunction("whatsapp-create-recurring-task", {
            userId: args.userId || hrAdmin.userId,
            organizationId: args.organizationId || hrAdmin.organizationId,
            title: args.title,
            description: args.description,
            assigneeId: args.assigneeId || args.userId || hrAdmin.userId,
            priority: args.priority || "medium",
            type: args.type || "Personal",
            recurrenceFrequency: args.recurrenceFrequency,
            startDate: startDate,
            endDate: args.endDate,
            numberOfOccurrences: args.numberOfOccurrences,
            completionWithinDays: args.completionWithinDays
          }, config);

          if (recurringResult.success) {
            const data = recurringResult.data;
            const freqMap: Record<string, string> = {
              'daily': 'every day',
              'weekly': 'every week', 
              'monthly': 'every month',
              'quarterly': 'every quarter',
              '6monthly': 'every 6 months',
              'yearly': 'every year'
            };
            const freqText = freqMap[args.recurrenceFrequency] || args.recurrenceFrequency;
            
            let response = `🔁 Set! I'll remind you ${freqText}.\n\n📋 ${data.template?.title || args.title}`;
            response += `\n⏰ ${freqText.charAt(0).toUpperCase() + freqText.slice(1)}`;
            
            if (data.template?.assigned_to_name && data.template.assigned_to_name !== hrAdmin.name) {
              response += `\n👤 For: ${data.template.assigned_to_name}`;
            }
            
            response += `\n\nYou won't forget this one 😉`;
            return response;
          } else {
            return `Hmm, that didn't work. ${recurringResult.error}\n\nMind trying again? 🙏`;
          }
        }

        case "delete_task": {
          const deleteResult = await this.callEdgeFunction("whatsapp-delete-task", {
            userId: args.userId || hrAdmin.userId,
            organizationId: args.organizationId || hrAdmin.organizationId,
            taskId: args.taskId,
            taskTitle: args.taskTitle
          }, config);

          if (deleteResult.success) {
            const deleted = deleteResult.data?.deleted_task;
            return `🗑️ Done! Removed "${deleted?.title || args.taskTitle}" from your list.`;
          } else {
            return `Hmm, couldn't find that one. ${deleteResult.error}\n\nCan you tell me more about which reminder? 🤔`;
          }
        }

        case "get_attendance": {
          const attendanceResult = await this.callEdgeFunction("whatsapp-get-attendance", {
            organizationId: args.organizationId || hrAdmin.organizationId,
            date: args.date || new Date().toISOString().split('T')[0]
          }, config);

          if (attendanceResult.success) {
            const data = attendanceResult.data;
            const stats = data.statistics;
            
            let report = `� Here's today's status:\n\n`;
            report += `✅ ${stats.present_count}/${stats.total_employees} in (${stats.attendance_percentage}%)\n`;
            
            if (stats.absent_count > 0) {
              report += `❌ ${stats.absent_count} absent\n`;
            }
            if (stats.late_count > 0) {
              report += `⏰ ${stats.late_count} late\n`;
            }

            if (data.absent?.length > 0 && data.absent.length <= 5) {
              report += `\n*Absent:*\n`;
              data.absent.forEach((u: any) => {
                report += `• ${u.name}\n`;
              });
            } else if (data.absent?.length > 5) {
              report += `\n*Absent:* ${data.absent.slice(0, 3).map((u: any) => u.name).join(', ')} +${data.absent.length - 3} more`;
            }

            if (data.late?.length > 0 && data.late.length <= 3) {
              report += `\n*Late:*\n`;
              data.late.forEach((u: any) => {
                report += `• ${u.name} (${u.punch_in_time})\n`;
              });
            }

            return report.trim();
          } else {
            return `Hmm, couldn't get attendance. ${attendanceResult.error}\n\nTry again? 🙏`;
          }
        }

        case "get_users": {
          const usersResult = await this.callEdgeFunction("whatsapp-get-users", {
            organizationId: args.organizationId || hrAdmin.organizationId,
            searchQuery: args.searchQuery || args.search_query,
            role: args.role,
            department: args.department
          }, config);

          if (usersResult.success) {
            const users = usersResult.data?.users || [];
            
            if (users.length === 0) {
              return `Couldn't find anyone matching that. Try a different name? 🔍`;
            }

            if (users.length === 1) {
              const u = users[0];
              let result = `Found them! 👤\n\n*${u.name}*`;
              if (u.department) result += `\n🏢 ${u.department}`;
              if (u.whatsapp_number) result += `\n📱 ${u.whatsapp_number}`;
              if (u.email) result += `\n📧 ${u.email}`;
              return result;
            }

            let result = `Found ${users.length} people:\n\n`;
            
            users.slice(0, 8).forEach((u: any) => {
              result += `• *${u.name}*`;
              if (u.department) result += ` (${u.department})`;
              result += '\n';
            });

            if (users.length > 8) {
              result += `\n...and ${users.length - 8} more`;
            }

            return result;
          } else {
            return `Hmm, couldn't search right now. ${usersResult.error}\n\nTry again? 🙏`;
          }
        }

        default:
          return `Unknown function: ${functionName}`;
      }
    } catch (error: any) {
      log(`❌ Function execution error: ${error.message}`);
      return `❌ Error executing ${functionName}: ${error.message}`;
    }
  }

  /**
   * Parse relative date strings to YYYY-MM-DD
   */
  private parseRelativeDate(dateStr: string): string {
    const lower = dateStr.toLowerCase().trim();
    const today = new Date();
    
    if (lower === 'today') {
      return today.toISOString().split('T')[0];
    }
    
    if (lower === 'tomorrow') {
      today.setDate(today.getDate() + 1);
      return today.toISOString().split('T')[0];
    }
    
    if (lower === 'next week') {
      today.setDate(today.getDate() + 7);
      return today.toISOString().split('T')[0];
    }

    // Check for "in X days"
    const inDaysMatch = lower.match(/in (\d+) days?/);
    if (inDaysMatch) {
      today.setDate(today.getDate() + parseInt(inDaysMatch[1]));
      return today.toISOString().split('T')[0];
    }

    // Return as-is if already in date format
    return dateStr;
  }

  /**
   * Call DigitalOcean AI Agent endpoint with function calling support
   * 
   * The DO AI Agent uses a simple endpoint format: https://xxx.agents.do-ai.run
   * It handles function calling internally and returns results directly.
   */
  async callRagEndpoint(
    conversationHistory: RagMessage[],
    config: HRChatbotConfig,
    hrAdmin: HRAdmin
  ): Promise<string> {
    const log = (msg: string) => console.log(`[HRChatbotService] ${msg}`);
    
    // DO AI Agent endpoint - use config or env var
    // Format: https://xxx.agents.do-ai.run/api/v1/chat/completions
    const baseUrl = config.ragBaseUrl || process.env.DO_HR_AGENT_ENDPOINT || "https://z4ufftljgd2h6oz32d56uj5r.agents.do-ai.run";
    const endpoint = baseUrl.includes('/api/v1/chat/completions') ? baseUrl : `${baseUrl}/api/v1/chat/completions`;
    const apiKey = config.ragAccessKey || process.env.DO_HR_AGENT_API_KEY;
    
    if (!apiKey) {
      throw new Error("DO AI Agent API key not configured");
    }
    
    // Build system message with user context (this will be part of conversation)
    const contextMessage = `[System Context]
User Name: ${hrAdmin.name || 'Admin'}
User ID: ${hrAdmin.userId}
Organization ID: ${hrAdmin.organizationId}
Organization Name: ${hrAdmin.organizationName || 'the organization'}
Current Date: ${new Date().toISOString().split('T')[0]}

Important: When calling functions, use the userId and organizationId from this context.`;

    // Add context to the beginning of conversation
    const messagesWithContext: RagMessage[] = [
      { role: "system", content: contextMessage },
      ...conversationHistory
    ];

    // DO AI Agent request body - simple format
    const requestBody = {
      messages: messagesWithContext,
      stream: false,
      max_tokens: 1000
    };

    log(`📡 Calling DO AI Agent: ${endpoint}`);
    log(`   Messages: ${conversationHistory.length}`);
    log(`   User: ${hrAdmin.name} (${hrAdmin.phoneNumber})`);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      log(`   Response status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        log(`❌ AI Agent error: ${errorText}`);
        throw new Error(`AI Agent returned ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      log(`   Response data: ${JSON.stringify(data).substring(0, 200)}...`);

      // DO AI Agent response format - check various formats
      // Format 1: { choices: [{ message: { content: "..." } }] }
      // Format 2: { message: "..." } or { response: "..." }
      // Format 3: { content: "..." }
      
      let responseText = "";
      
      if (data.choices && data.choices.length > 0) {
        const choice = data.choices[0];
        const message = choice.message;

        // Check if AI wants to call a function (OpenAI format)
        if (message.tool_calls && message.tool_calls.length > 0) {
          log(`🔧 AI requested ${message.tool_calls.length} function call(s)`);
          
          const results: string[] = [];
          
          for (const toolCall of message.tool_calls) {
            if (toolCall.type === "function") {
              const funcName = toolCall.function.name;
              const funcArgs = JSON.parse(toolCall.function.arguments || "{}");
              
              log(`   Executing: ${funcName}(${JSON.stringify(funcArgs)})`);
              
              const result = await this.executeFunction(funcName, funcArgs, hrAdmin, config);
              results.push(result);
            }
          }
          
          return results.join('\n\n');
        }

        // Regular text response
        responseText = message.content || "";
      } else if (data.message) {
        responseText = data.message;
      } else if (data.response) {
        responseText = data.response;
      } else if (data.content) {
        responseText = data.content;
      } else if (typeof data === "string") {
        responseText = data;
      }

      if (responseText) {
        return responseText.trim();
      }

      return "Hey! 👋 I'm here to help. What would you like me to remember for you?";

    } catch (error: any) {
      log(`❌ AI Agent error: ${error.message}`);
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

      // Get HR chatbot config
      const config = await this.storage.getHRChatbotConfig();
      
      if (!config || config.isActive !== "true") {
        log(`⚠️ HR Chatbot not configured or inactive`);
        return;
      }

      // Check if chatbot is active for this admin
      if (hrAdmin.chatbotActive !== "true") {
        log(`⏸️ HR Chatbot paused for ${phoneNumber}`);
        return;
      }

      // Get conversation history
      const limit = config.contextMessageCount || 5;
      const history = await this.getConversationHistory(phoneNumber, limit);

      log(`   Retrieved ${history.length} messages from history`);

      // Add current message
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

      // Call RAG endpoint with function support
      const botResponse = await this.callRagEndpoint(ragMessages, config, hrAdmin);

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
   * Test HR chatbot connection
   */
  async testConnection(config: HRChatbotConfig): Promise<{ success: boolean; message: string }> {
    const log = (msg: string) => console.log(`[HRChatbotService] ${msg}`);
    
    try {
      log(`🧪 Testing HR RAG endpoint: ${config.ragBaseUrl}`);

      const testMessages: RagMessage[] = [
        { role: "user", content: "Hello, test connection" }
      ];

      // Create mock HR admin for test
      const mockHRAdmin: HRAdmin = {
        id: 'test',
        phoneNumber: 'test',
        name: 'Test Admin',
        organizationId: 'test-org',
        userId: 'test-user',
        whatsappUserId: null,
        organizationName: 'Test Organization',
        chatbotActive: 'true',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const response = await this.callRagEndpoint(testMessages, config, mockHRAdmin);

      log(`✅ Test successful: ${response.substring(0, 50)}...`);

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
