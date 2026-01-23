# HR / Task Management WhatsApp Integration

This document explains the integration between the WhatsApp Persistent backend and the Task Management (HR) application.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        WhatsApp Persistent                              │
│                                                                         │
│  ┌────────────┐    ┌────────────────────────────────────────────────┐   │
│  │  WhatsApp  │───▶│                Message Router                  │   │
│  │   User     │    │                                                │   │
│  └────────────┘    │  ┌──────────────────┐ ┌───────────────────┐    │   │
│                    │  │ Is HR Admin?      │ │ Is Lead?          │    │   │
│                    │  │ ▼                 │ │ ▼                 │    │   │
│                    │  │ HRChatbotService  │ │ ChatbotService    │    │   │
│                    │  └────────┬─────────┘ └────────┬──────────┘    │   │
│                    └───────────┼────────────────────┼───────────────┘   │
│                                │                    │                    │
│                                ▼                    │                    │
│                    ┌───────────────────┐            │                    │
│                    │ Anthropic Claude  │            │                    │
│                    │ (Tool Calling)    │            ▼                    │
│                    └────────┬──────────┘ ┌─────────────────────┐        │
│                             │            │ DO AI Agent (LIMS)  │        │
│                             │            │ + RAG Knowledge     │        │
│                             │            └─────────────────────┘        │
└─────────────────────────────┼────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     DigitalOcean Serverless Functions                   │
│                                                                         │
│  ┌──────────────────────┐ ┌──────────────────┐ ┌──────────────────┐    │
│  │ create-task          │ │ get-attendance   │ │ get-users        │    │
│  │ create-recurring-task│ │                  │ │                  │    │
│  │ delete-task          │ │                  │ │                  │    │
│  └──────────────────────┘ └──────────────────┘ └──────────────────┘    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Task Management Supabase                            │
│                                                                         │
│  ┌──────────────────────┐ ┌──────────────────┐ ┌──────────────────┐    │
│  │ whatsapp-create-task │ │ whatsapp-get-    │ │ whatsapp-get-    │    │
│  │                      │ │ attendance       │ │ users            │    │
│  └──────────────────────┘ └──────────────────┘ └──────────────────┘    │
│                                                                         │
│  ┌──────────────────────┐ ┌──────────────────┐ ┌──────────────────┐    │
│  │   organizations      │ │     users        │ │     tasks        │    │
│  └──────────────────────┘ └──────────────────┘ └──────────────────┘    │
│  ┌──────────────────────┐                                               │
│  │     attendance       │                                               │
│  └──────────────────────┘                                               │
└─────────────────────────────────────────────────────────────────────────┘
```

## Architecture Change (Jan 2026)

**Previously**: Used DigitalOcean AI Agent for LLM processing with function calling
**Now**: Using Anthropic Claude directly with native tool calling

### Why the Change?
- DO AI Agent had reliability issues with function calling execution
- Functions would timeout or fail silently
- Claude's native tool calling is more reliable and battle-tested

### New Flow
1. WhatsApp message → HRChatbotService
2. HRChatbotService → Anthropic Claude API (with tool definitions)
3. Claude returns `tool_use` blocks → Service executes via DO Functions
4. Results sent back to Claude for final response formatting
5. Final response sent via WhatsApp

## User Types & Routing

When a message arrives, the system checks in this order:

1. **Is Blocked?** → Skip processing
2. **Is HR Admin?** → Route to `HRChatbotService`
3. **Is Lead?** → Route to `ChatbotService` (LIMS)
4. **None of above** → Check auto-responses

### HR Admin Detection
```typescript
// routes.ts - processIncomingMessage()
const hrChatbotService = new HRChatbotService(storage, whatsAppService);
const isHRAdmin = await hrChatbotService.isHRAdmin(data.phoneNumber);

if (isHRAdmin) {
  // Process through HR chatbot (Task Management)
  await hrChatbotService.processHRMessage(data.phoneNumber, data.content);
}
```

### Lead Detection
```typescript
// routes.ts - processIncomingMessage()
const chatbotService = new ChatbotService(storage, whatsAppService);
const isLead = await chatbotService.isLead(data.phoneNumber);

if (isLead) {
  // Process through LIMS chatbot
  await chatbotService.processLeadMessage(data.phoneNumber, data.content);
}
```

## Database Schema

### HR Admins Table (`hr_admins`)
```sql
CREATE TABLE hr_admins (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL UNIQUE,
  name TEXT,
  organization_id TEXT NOT NULL,     -- Supabase org ID
  user_id TEXT NOT NULL,              -- Supabase user ID
  organization_name TEXT,
  chatbot_active TEXT DEFAULT 'true', -- Pause/resume
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### HR Chatbot Config (`hr_chatbot_configs`)
```sql
CREATE TABLE hr_chatbot_configs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,
  rag_base_url TEXT NOT NULL,         -- DO AI Agent URL
  rag_access_key TEXT NOT NULL,       -- DO AI Agent key
  supabase_url TEXT NOT NULL,         -- Task Mgmt Supabase
  supabase_service_key TEXT NOT NULL, -- For edge functions
  context_message_count INTEGER DEFAULT 5,
  is_active TEXT DEFAULT 'true',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

## API Endpoints

### HR Admin Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/hr-admins` | List all HR admins |
| POST | `/api/hr-admins` | Register new HR admin |
| GET | `/api/hr-admins/:phone/conversation` | Get conversation history |
| DELETE | `/api/hr-admins/:phone` | Remove HR admin |
| PATCH | `/api/hr-admins/:phone/chatbot-status` | Toggle chatbot active |

### HR Chatbot Config

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/hr-chatbot/config` | Get current config |
| PUT | `/api/hr-chatbot/config` | Update config |
| POST | `/api/hr-chatbot/test` | Test connection |

## Registering an HR Admin

### Via API
```bash
curl -X POST http://localhost:5000/api/hr-admins \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "919876543210",
    "name": "John Doe",
    "organizationId": "uuid-from-supabase-organizations",
    "userId": "uuid-from-supabase-users",
    "organizationName": "Acme Corp"
  }'
```

### Via UI
1. Go to Dashboard → HR / Tasks
2. Click "Register HR Admin"
3. Fill in:
   - WhatsApp Phone Number
   - Name (optional)
   - Organization ID (from Supabase)
   - User ID (from Supabase)
   - Organization Name (optional)

## HRChatbotService Features

### Function Calling
The HR chatbot uses AI function calling to interact with Task Management:

#### `create_task`
Creates a new task in the system.
```json
{
  "title": "Review monthly reports",
  "description": "Check all department reports",
  "assignee_name": "Priyanka",  // Will search for user
  "priority": "high",
  "due_date": "tomorrow",       // Supports relative dates
  "type": "Advisory"
}
```

User examples:
- "Create a task: Review reports"
- "Remind Priyanka to submit attendance"
- "Add high priority task for team meeting"

#### `get_attendance`
Gets attendance report for a date.
```json
{
  "date": "2024-01-20"  // Optional, defaults to today
}
```

User examples:
- "Show today's attendance"
- "Who is absent today?"
- "Get attendance for yesterday"

#### `get_users`
Searches or lists users.
```json
{
  "search_query": "Rahul",
  "role": "admin",
  "department": "HR"
}
```

User examples:
- "Find employee Rahul"
- "List all admins"
- "Show HR department"

### Edge Function Integration

The service calls Supabase edge functions directly:

```typescript
// HRChatbotService.ts
private async callEdgeFunction(functionName: string, payload: any, config: HRChatbotConfig) {
  const url = `${config.supabaseUrl}/functions/v1/${functionName}`;
  
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.supabaseServiceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  
  return response.json();
}
```

## Task Management Edge Functions

### whatsapp-create-task
Creates tasks with validation.

**Required fields:**
- `userId` - Creator's user ID
- `organizationId` - Organization ID
- `title` - Task title

**Optional fields:**
- `description`
- `assigneeId` - User ID to assign to
- `priority` - high/medium/low
- `dueDate` - ISO date string
- `type` - Task type

### whatsapp-get-attendance
Gets attendance for a date.

**Required fields:**
- `organizationId`

**Optional fields:**
- `date` - YYYY-MM-DD format, defaults to today

**Returns:**
- statistics (present, absent, late counts)
- present users list
- absent users list
- late users list

### whatsapp-get-users
Searches/lists users.

**Required fields:**
- `organizationId`

**Optional fields:**
- `searchQuery` - Name/email search
- `role` - user/admin/superadmin
- `department` - Department filter

## Configuration

### HR Chatbot Config
Via UI (HR / Tasks → Chatbot Config):

1. **Agent Name**: Display name
2. **RAG Base URL**: DigitalOcean AI Agent URL
3. **RAG Access Key**: Agent access key
4. **Supabase URL**: Task Management Supabase URL
5. **Supabase Service Key**: Service role key for edge functions
6. **Context Messages**: Number of previous messages for context

### Environment Variables (Alternative)
```env
HR_RAG_BASE_URL=https://your-hr-agent.agents.do-ai.run
HR_RAG_ACCESS_KEY=your-access-key
TASK_SUPABASE_URL=https://your-project.supabase.co
TASK_SUPABASE_SERVICE_KEY=your-service-role-key
```

## Example Conversation Flow

```
User: Create a task for Priyanka to review attendance
│
▼ WhatsApp Persistent receives message
│
▼ Checks: Is 919876543210 an HR Admin? → YES
│
▼ HRChatbotService.processHRMessage()
│
▼ Calls DO AI Agent with function calling
│
▼ AI decides to call create_task function
│
▼ HRChatbotService.executeFunction("create_task", {
│   title: "Review attendance",
│   assignee_name: "Priyanka"
│ })
│
▼ First searches for "Priyanka" via whatsapp-get-users
│
▼ Then creates task via whatsapp-create-task
│
▼ Returns formatted response
│
▼ Sends WhatsApp message:
   "✅ Task created successfully!
    📋 Review attendance
    - Priority: medium
    - Status: pending
    - Assigned to: Priyanka Panchal"
```

## Pause/Resume HR Chatbot

Like leads, HR admins can have their chatbot paused:

```bash
# Pause
curl -X PATCH http://localhost:5000/api/hr-admins/919876543210/chatbot-status \
  -H "Content-Type: application/json" \
  -d '{"active": false}'

# Resume
curl -X PATCH http://localhost:5000/api/hr-admins/919876543210/chatbot-status \
  -H "Content-Type: application/json" \
  -d '{"active": true}'
```

When paused, messages are stored but not processed through the AI.

## Troubleshooting

### HR Admin not getting responses
1. Check if phone number is registered as HR admin
2. Check if `chatbotActive` is "true"
3. Check HR chatbot config is set
4. Check logs for edge function errors

### Edge function errors
1. Verify `supabaseServiceKey` is valid
2. Check edge function is deployed
3. Verify `organizationId` and `userId` are valid
4. Check Supabase function logs

### AI not calling functions
1. Ensure DO AI Agent has function definitions
2. Check RAG access key is valid
3. Review AI agent system prompt

## Files Reference

| File | Purpose |
|------|---------|
| `shared/schema.ts` | Database schema (hrAdmins, hrChatbotConfigs) |
| `server/services/HRChatbotService.ts` | HR chatbot logic & edge function calls |
| `server/routes.ts` | API endpoints & message routing |
| `server/storage/DatabaseStorage.ts` | Database operations |
| `client/src/components/dashboard/HRAdminsPanel.tsx` | Frontend UI |
| `client/src/components/dashboard/Sidebar.tsx` | Navigation |
