import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer } from "ws";
import multer from "multer";
import cors from "cors";
import { storage } from "./storage";
import { whatsAppService } from "./services/WhatsAppService";
import { messageService } from "./services/MessageService";
import { fileService } from "./services/FileService";
import { persistentFileService } from "./services/PersistentFileService";
import { campaignService } from "./services/CampaignService";
import { autoResponseService } from "./services/AutoResponseService";
import { ChatbotService } from "./services/ChatbotService";
import { HRChatbotService } from "./services/HRChatbotService";
import { initializeChatbotConfig } from "./initChatbot";
import { sendMessageSchema, sendReportSchema, createCampaignSchema, bulkSendSchema, chatbotConfigSchema, flagLeadSchema, registerHRAdminSchema, hrChatbotConfigSchema } from "@shared/schema";
import { log } from "./utils";
import { getDbHealth } from "./db";
import { withRetry } from "./dbRetry";
import * as XLSX from 'xlsx';

// Configure CORS
const corsOptions = {
  origin: [
    "http://localhost:4173",
    "http://localhost:5173",
    ...(process.env.REPLIT_DOMAINS ? process.env.REPLIT_DOMAINS.split(',') : [])
  ],
  credentials: true,
};

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760'), // 10MB default
  },
});

export async function registerRoutes(app: Express): Promise<Server> {
  // Apply CORS middleware
  app.use(cors(corsOptions));

  // Initialize WhatsApp service
  try {
    await whatsAppService.initialize();
    log("WhatsApp service initialized successfully");
  } catch (error) {
    log(`Failed to initialize WhatsApp service: ${error.message}`);
  }

  // Initialize chatbot configuration
  await initializeChatbotConfig();

  // Create HTTP server
  const httpServer = createServer(app);

  // Setup WebSocket server for real-time communication
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  // WebSocket connection handling
  wss.on('connection', (ws) => {
    log('WebSocket client connected');

    // Send current WhatsApp status
    const status = whatsAppService.getStatus();
    ws.send(JSON.stringify({
      type: 'whatsapp-status',
      data: status,
    }));

    ws.on('close', () => {
      log('WebSocket client disconnected');
    });

    ws.on('error', (error) => {
      log(`WebSocket error: ${error.message}`);
    });
  });

  // Broadcast function for WebSocket messages
  const broadcast = (type: string, data: any) => {
    const message = JSON.stringify({ type, data });
    console.log(`Broadcasting ${type} to ${wss.clients.size} clients:`, data);
    wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN) {
        client.send(message);
      }
    });
  };

  // Setup WhatsApp service event listeners with reconnection handling
  const setupWhatsAppEventListeners = () => {
    // Don't remove all listeners as it breaks ongoing QR code broadcasting
    // Only set up listeners if they don't exist already

    whatsAppService.on('qr-code', (data) => {
      console.log('🎯 ROUTES: Received qr-code event from WhatsApp service');
      console.log('🎯 QR Data received:', data);
      console.log('🎯 WebSocket clients count:', wss.clients.size);
      console.log('🎯 Broadcasting QR code to WebSocket clients...');
      broadcast('qr-code', data);
      console.log('🎯 QR code broadcast completed');
    });

    whatsAppService.on('whatsapp-status', (data) => {
      broadcast('whatsapp-status', data);
    });

    whatsAppService.on('whatsapp-authenticated', (data) => {
      broadcast('whatsapp-authenticated', data);
    });

    whatsAppService.on('whatsapp-auth-failure', (data) => {
      broadcast('whatsapp-auth-failure', data);
    });

    whatsAppService.on('disconnected', (data) => {
      broadcast('disconnected', data);
    });

    whatsAppService.on('message-sent', (data) => {
      broadcast('message-sent', data);
    });

    whatsAppService.on('message-update', async (data) => {
      // Update message delivery status
      await messageService.updateMessageDeliveryStatus(data.messageId, data.ack === 3 ? 'delivered' : 'failed');
      broadcast('message-update', data);
    });

    whatsAppService.on('button-clicked', async (data) => {
      console.log('📱 Button clicked event received:', data);

      // Handle STOP_MESSAGES button
      if (data.buttonId === 'STOP_MESSAGES') {
        try {
          await storage.addToBlocklist(data.phoneNumber, 'user_requested');
          console.log(`✅ Added ${data.phoneNumber} to blocklist`);

          // Send confirmation message
          await whatsAppService.sendTextMessage(
            data.phoneNumber,
            '✅ You have been unsubscribed. You will not receive any more messages from us.'
          );
        } catch (error) {
          console.error('Failed to block number:', error);
        }
      }

      broadcast('button-clicked', data);
    });

    // Message debouncing: prevent spam when user sends multiple messages quickly
    const messageDebounceMap = new Map<string, NodeJS.Timeout>();
    const DEBOUNCE_DELAY = 3000; // 3 seconds

    // Handle incoming messages
    whatsAppService.on('incoming-message', async (data) => {
      console.log('📥 Incoming message received:', data);

      // Clear existing timeout for this phone number if any
      const existingTimeout = messageDebounceMap.get(data.phoneNumber);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
        console.log(`⏱️ Debouncing message from ${data.phoneNumber}`);
      }

      // Set new timeout - only process if no new message arrives within DEBOUNCE_DELAY
      const timeoutId = setTimeout(async () => {
        messageDebounceMap.delete(data.phoneNumber);
        await processIncomingMessage(data);
      }, DEBOUNCE_DELAY);

      messageDebounceMap.set(data.phoneNumber, timeoutId);
    });

    // Extract message processing logic
    async function processIncomingMessage(data: any) {

      try {
        // Save incoming message to database with retry
        await withRetry(() => storage.createMessage({
          phoneNumber: data.phoneNumber,
          content: data.content,
          type: 'incoming',
          status: 'received',
        }));

        // Check if number is blocked
        const isBlocked = await withRetry(() => storage.isNumberBlocked(data.phoneNumber));
        if (isBlocked) {
          console.log(`⛔ Ignoring message from blocked number: ${data.phoneNumber}`);
          broadcast('incoming-message', data);
          return;
        }

        // ========================================
        // PRIORITY 1: Check if HR Admin
        // ========================================
        const hrChatbotService = new HRChatbotService(storage, whatsAppService);
        const isHRAdmin = await withRetry(() => hrChatbotService.isHRAdmin(data.phoneNumber));
        
        if (isHRAdmin) {
          console.log(`👔 HR Admin detected: ${data.phoneNumber} (messageType: ${data.messageType || 'text'})`);
          
          // Check if HR chatbot is active for this admin
          const hrAdmin = await withRetry(() => storage.getHRAdmin(data.phoneNumber));
          console.log(`🔍 HR Chatbot status for ${data.phoneNumber}: ${hrAdmin?.chatbotActive === 'false' ? 'PAUSED ⏸️' : 'ACTIVE ✅'}`);
          
          if (hrAdmin?.chatbotActive === 'false') {
            console.log(`⏸️ HR Chatbot paused for ${data.phoneNumber} - skipping`);
            broadcast('incoming-message', data);
            return;
          }

          // Handle different message types
          const messageType = data.messageType || 'text';
          
          if (messageType === 'voice_note' || messageType === 'audio') {
            // Voice notes - send to Claude for transcription and processing
            if (data.audioData) {
              console.log(`🎤 Processing voice note from HR Admin ${data.phoneNumber} through Claude`);
              const audioPayload = {
                base64: data.audioData,
                mimetype: data.mediaInfo?.mimetype || 'audio/ogg'
              };
              await hrChatbotService.processHRMessage(data.phoneNumber, '[Voice Note]', audioPayload);
              broadcast('hr-chatbot-response-sent', { phoneNumber: data.phoneNumber, type: 'voice_processed' });
              broadcast('incoming-message', data);
              return;
            } else {
              // No audio data available (download failed)
              console.log(`🎤 Voice note from HR Admin ${data.phoneNumber} - no audio data, sending acknowledgment`);
              await whatsAppService.sendMessage(
                data.from || `${data.phoneNumber}@s.whatsapp.net`,
                "🎤 I received your voice note but couldn't process it. Please try again or type your message."
              );
              broadcast('hr-chatbot-response-sent', { phoneNumber: data.phoneNumber, type: 'voice_failed' });
              broadcast('incoming-message', data);
              return;
            }
          }
          
          if (messageType === 'image' || messageType === 'video' || messageType === 'document') {
            // For media, acknowledge but can't process
            console.log(`📎 Media (${messageType}) from HR Admin ${data.phoneNumber} - sending acknowledgment`);
            await whatsAppService.sendMessage(
              data.from || `${data.phoneNumber}@s.whatsapp.net`,
              `📎 I received your ${messageType}! However, I can only process text messages at the moment.\n\nPlease type your request and I'll be happy to help.`
            );
            broadcast('hr-chatbot-response-sent', { phoneNumber: data.phoneNumber, type: 'media_acknowledgment' });
            broadcast('incoming-message', data);
            return;
          }

          // Process text message through HR chatbot
          console.log(`🤖 Processing HR message from ${data.phoneNumber} (org: ${hrAdmin?.organizationName || hrAdmin?.organizationId})`);
          await hrChatbotService.processHRMessage(data.phoneNumber, data.content);
          broadcast('hr-chatbot-response-sent', { phoneNumber: data.phoneNumber });
          broadcast('incoming-message', data);
          return;
        }

        // ========================================
        // PRIORITY 2: Check if Lead (LIMS chatbot)
        // ========================================
        
        // Initialize lead chatbot service
        const chatbotService = new ChatbotService(storage, whatsAppService);

        // Check if this phone number is already a lead
        const isAlreadyLead = await withRetry(() => chatbotService.isLead(data.phoneNumber));

        // Check if message contains lead trigger keyword (only flag if not already a lead)
        if (!isAlreadyLead) {
          const triggerKeyword = await chatbotService.detectLeadTrigger(data.content);
          if (triggerKeyword) {
            console.log(`🎯 Lead trigger detected: "${triggerKeyword}" from ${data.phoneNumber}`);
            await withRetry(() => chatbotService.flagAsLead(
              data.phoneNumber,
              triggerKeyword
            ));
            // After flagging and sending greeting, skip processing this message through RAG
            // The greeting is sufficient for first contact
            broadcast('incoming-message', data);
            return;
          }
        }

        // Check if this phone number is a lead
        const isLead = await withRetry(() => chatbotService.isLead(data.phoneNumber));
        console.log(`🔍 Lead check for ${data.phoneNumber}: ${isLead ? 'YES (will process through chatbot)' : 'NO (checking auto-responses)'}`);

        if (isLead) {
          // Check if chatbot is active for this lead
          const contact = await withRetry(() => storage.getContact(data.phoneNumber));
          console.log(`🔍 Chatbot status check for ${data.phoneNumber}: ${contact?.chatbotActive === 'false' ? 'PAUSED ⏸️' : 'ACTIVE ✅'} (value: ${contact?.chatbotActive})`);
          
          if (contact?.chatbotActive === 'false') {
            console.log(`⏸️ Chatbot paused for ${data.phoneNumber} - skipping auto-response`);
            broadcast('incoming-message', data);
            return;
          }

          // Process through chatbot for leads
          console.log(`🤖 Processing lead message from ${data.phoneNumber}`);
          await chatbotService.processLeadMessage(data.phoneNumber, data.content);
          broadcast('chatbot-response-sent', { phoneNumber: data.phoneNumber });
        } else {
          // ========================================
          // PRIORITY 3: Check auto-responses for non-leads
          // ========================================
          const responded = await withRetry(() =>
            autoResponseService.handleIncomingMessage(
              data.phoneNumber,
              data.content
            )
          );

          if (responded) {
            console.log(`✅ Auto-response sent to ${data.phoneNumber}`);
          }
        }

        // Broadcast to WebSocket clients
        broadcast('incoming-message', data);
      } catch (error) {
        console.error('❌ Failed to handle incoming message:', error);
        console.error('Error details:', {
          phoneNumber: data?.phoneNumber,
          content: data?.content?.substring(0, 50),
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : undefined
        });
        // Still broadcast the message even if processing failed
        broadcast('incoming-message', data);
      }
    }
  };

  setupWhatsAppEventListeners();

  // API Routes

  // Send text message
  app.post('/api/send-message', async (req, res) => {
    try {
      const validatedData = sendMessageSchema.parse(req.body);
      const message = await messageService.sendTextMessage(
        validatedData.phoneNumber,
        validatedData.content
      );

      res.json({ success: true, message });
    } catch (error) {
      log(`Send message error: ${error.message}`);
      res.status(400).json({
        success: false,
        error: error.message || 'Failed to send message'
      });
    }
  });

  // Send report with file attachment
  app.post('/api/send-report', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No file provided'
        });
      }

      const validatedData = sendReportSchema.parse(req.body);

      // Save uploaded file with persistent storage for deployment
      const fileInfo = process.env.DATABASE_URL
        ? await persistentFileService.saveFile(req.file)
        : await fileService.saveFile(req.file);

      try {
        // Send report message
        const message = await messageService.sendReportMessage(
          validatedData.phoneNumber,
          fileInfo.filePath,
          fileInfo.fileName,
          fileInfo.size,
          validatedData.sampleId,
          validatedData.content
        );

        // Schedule file cleanup after successful send
        setTimeout(async () => {
          await fileService.deleteFile(fileInfo.filePath);
        }, 5 * 60 * 1000); // Delete after 5 minutes

        res.json({ success: true, message });
      } catch (sendError) {
        // Clean up file if sending failed
        await fileService.deleteFile(fileInfo.filePath);
        throw sendError;
      }
    } catch (error) {
      log(`Send report error: ${error.message}`);
      res.status(400).json({
        success: false,
        error: error.message || 'Failed to send report'
      });
    }
  });

  // Health check endpoint for DigitalOcean with DB verification
  app.get('/api/health', async (req, res) => {
    const startTime = Date.now();
    const dbHealthy = await getDbHealth();
    const dbLatency = Date.now() - startTime;

    const health = {
      success: true,
      message: 'Server is running',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: {
        connected: dbHealthy,
        latency: `${dbLatency}ms`
      }
    };

    // Return 503 if DB is down so load balancer can route away
    res.status(dbHealthy ? 200 : 503).json(health);
  });

  // Get system status
  app.get('/api/status', async (req, res) => {
    try {
      const whatsappStatus = whatsAppService.getStatus();
      const messageStats = await messageService.getMessageStats();
      const systemLogs = await storage.getSystemLogs(10);

      res.json({
        success: true,
        data: {
          whatsapp: whatsappStatus,
          stats: messageStats,
          systemLogs,
          timestamp: new Date().toISOString(),
        }
      });
    } catch (error) {
      log(`Status error: ${error.message}`);
      res.status(500).json({
        success: false,
        error: 'Failed to get system status'
      });
    }
  });

  // Get message history
  app.get('/api/messages', async (req, res) => {
    try {
      const { status, phoneNumber, type, limit = '50', offset = '0', search } = req.query;

      const filters: any = {
        limit: parseInt(limit as string),
        offset: parseInt(offset as string),
      };

      if (status && status !== 'all') filters.status = status;
      if (phoneNumber) filters.phoneNumber = phoneNumber;
      if (type) filters.type = type;

      const result = await messageService.getMessageHistory(filters);

      // Apply search filter if provided
      let { messages } = result;
      if (search && typeof search === 'string') {
        const searchLower = search.toLowerCase();
        messages = messages.filter(msg =>
          msg.content.toLowerCase().includes(searchLower) ||
          msg.phoneNumber.includes(search) ||
          (msg.sampleId && msg.sampleId.toLowerCase().includes(searchLower))
        );
      }

      res.json({
        success: true,
        data: {
          messages,
          total: result.total,
          limit: filters.limit,
          offset: filters.offset,
        }
      });
    } catch (error) {
      log(`Get messages error: ${error.message}`);
      res.status(500).json({
        success: false,
        error: 'Failed to get message history'
      });
    }
  });

  // Generate QR code endpoint
  app.post('/api/generate-qr', async (req: Request, res: Response) => {
    try {
      log('Generate QR code request received');
      await whatsAppService.generateQRCode();
      res.json({ success: true, message: 'QR code generation started' });
    } catch (error: any) {
      log(`Generate QR error: ${error.message}`);
      res.status(400).json({
        success: false,
        error: error.message || 'Failed to generate QR code'
      });
    }
  });

  // Get current QR code endpoint (fallback for when WebSocket fails)
  app.get('/api/qr-code', (req: Request, res: Response) => {
    try {
      // Return the last generated QR code
      const currentQR = whatsAppService.getCurrentQR();
      if (currentQR) {
        res.json({
          success: true,
          data: {
            qr: currentQR.qr,
            generated: currentQR.timestamp,
            message: 'QR code available for scanning'
          }
        });
      } else {
        res.json({
          success: false,
          message: 'No QR code available. WhatsApp service initializing...'
        });
      }
    } catch (error: any) {
      log(`Get QR error: ${error.message}`);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to get QR code'
      });
    }
  });

  // WhatsApp API endpoints
  app.get('/api/whatsapp/status', async (req, res) => {
    try {
      const status = whatsAppService.getStatus();
      res.json({
        success: true,
        data: status
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`WhatsApp status error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        error: 'Failed to get WhatsApp status'
      });
    }
  });

  app.post('/api/whatsapp/connect', async (req, res) => {
    try {
      // Re-setup event listeners before connecting
      setupWhatsAppEventListeners();

      const result = await whatsAppService.initialize();
      res.json({
        success: true,
        message: 'WhatsApp connection initiated'
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`WhatsApp connect error: ${errorMessage}`);
      res.status(400).json({
        success: false,
        error: errorMessage || 'Failed to connect to WhatsApp'
      });
    }
  });

  app.post('/api/whatsapp/disconnect', async (req, res) => {
    try {
      await whatsAppService.disconnect();
      res.json({
        success: true,
        message: 'WhatsApp disconnected successfully'
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`WhatsApp disconnect error: ${errorMessage}`);
      res.status(400).json({
        success: false,
        error: errorMessage || 'Failed to disconnect from WhatsApp'
      });
    }
  });

  app.get('/api/whatsapp/qr', async (req, res) => {
    try {
      // For now, return a placeholder since qrCode isn't in the status type
      // The QR code will be handled via WebSocket events
      res.json({
        success: false,
        error: 'QR code available via WebSocket events only. Use /api/generate-qr endpoint.'
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`WhatsApp QR error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        error: 'Failed to get QR code'
      });
    }
  });

  // Resend failed message
  app.post('/api/messages/:id/resend', async (req, res) => {
    try {
      const { id } = req.params;
      const message = await messageService.resendMessage(id);

      res.json({ success: true, message });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Resend message error: ${errorMessage}`);
      res.status(400).json({
        success: false,
        error: errorMessage || 'Failed to resend message'
      });
    }
  });

  // Get system logs
  app.get('/api/logs', async (req, res) => {
    try {
      const { limit = '50', offset = '0' } = req.query;
      const logs = await storage.getSystemLogs(
        parseInt(limit as string),
        parseInt(offset as string)
      );

      res.json({ success: true, data: logs });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get logs error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        error: 'Failed to get system logs'
      });
    }
  });

  // Campaign Routes

  // Create campaign
  app.post('/api/campaigns', async (req, res) => {
    try {
      const validatedData = createCampaignSchema.parse(req.body);
      const campaign = await withRetry(() => campaignService.createCampaign(
        validatedData.name,
        validatedData.originalMessage,
        validatedData.fixedParams,
        validatedData.buttons,
        validatedData.includeStopButton
      ));

      res.json({ success: true, data: campaign });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Create campaign error: ${errorMessage}`);
      res.status(400).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // Upload attachment for campaign
  app.post('/api/campaigns/:campaignId/attachment', upload.single('file'), async (req, res) => {
    try {
      const { campaignId } = req.params;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No file provided'
        });
      }

      // Save uploaded file
      const fileInfo = process.env.DATABASE_URL
        ? await persistentFileService.saveFile(req.file)
        : await fileService.saveFile(req.file);

      // Update campaign with attachment path
      const campaign = await campaignService.updateCampaignAttachment(
        campaignId,
        fileInfo.filePath,
        fileInfo.fileName
      );

      res.json({ success: true, data: campaign });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Upload attachment error: ${errorMessage}`);
      res.status(400).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // Download campaign attachment
  app.get('/api/campaigns/:campaignId/attachment/download', async (req, res) => {
    try {
      const { campaignId } = req.params;
      const campaign = await campaignService.getCampaign(campaignId);

      if (!campaign || !campaign.attachmentPath) {
        return res.status(404).json({
          success: false,
          error: 'Attachment not found'
        });
      }

      res.download(campaign.attachmentPath, campaign.attachmentName || 'attachment');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Download attachment error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // Get campaign
  app.get('/api/campaigns/:campaignId', async (req, res) => {
    try {
      const { campaignId } = req.params;
      const campaign = await campaignService.getCampaign(campaignId);

      if (!campaign) {
        return res.status(404).json({
          success: false,
          error: 'Campaign not found'
        });
      }

      res.json({ success: true, data: campaign });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get campaign error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // Upload contacts for campaign
  app.post('/api/campaigns/:campaignId/contacts/upload', upload.single('file'), async (req, res) => {
    try {
      const { campaignId } = req.params;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No file provided'
        });
      }

      // Parse Excel file
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(worksheet) as any[];

      // Validate and format contacts
      const contacts = data.map((row: any) => {
        if (!row.name || !row.phone) {
          throw new Error('Invalid file format. Expected columns: name, phone');
        }

        const { name, phone, ...extra } = row;
        return {
          name: String(name),
          phone: String(phone),
          extra,
        };
      });

      // Upload to database
      const result = await campaignService.uploadContacts(campaignId, contacts);

      res.json(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Upload contacts error: ${errorMessage}`);
      res.status(400).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // Get contacts for campaign
  app.get('/api/campaigns/:campaignId/contacts', async (req, res) => {
    try {
      const { campaignId } = req.params;
      const contacts = await campaignService.getContacts(campaignId);

      res.json({
        success: true,
        data: contacts,
        total: contacts.length
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get contacts error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // Save message variation
  app.post('/api/campaigns/:campaignId/variations', async (req, res) => {
    try {
      const { campaignId } = req.params;
      const { variation } = req.body;

      if (!variation) {
        return res.status(400).json({
          success: false,
          error: 'Variation message is required'
        });
      }

      const saved = await campaignService.saveMessageVariation(campaignId, variation);
      await campaignService.updateCampaignVariation(campaignId, variation);

      res.json({ success: true, data: saved });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Save variation error: ${errorMessage}`);
      res.status(400).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // Get message variations
  app.get('/api/campaigns/:campaignId/variations', async (req, res) => {
    try {
      const { campaignId } = req.params;
      const variations = await campaignService.getMessageVariations(campaignId);

      res.json({
        success: true,
        data: variations
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get variations error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // Bulk send campaign messages
  app.post('/api/campaigns/:campaignId/send-bulk', async (req, res) => {
    try {
      const { campaignId } = req.params;
      const validatedData = bulkSendSchema.parse(req.body);

      const result = await campaignService.sendBulkMessages(
        campaignId,
        validatedData.variation_message,
        validatedData.contacts
      );

      res.json(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Bulk send error: ${errorMessage}`);
      res.status(400).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // Block a phone number
  app.post('/api/blocklist/add', async (req, res) => {
    try {
      const { phoneNumber, reason } = req.body;

      if (!phoneNumber) {
        return res.status(400).json({ success: false, error: 'Phone number is required' });
      }

      await storage.addToBlocklist(phoneNumber, reason || 'user_requested');

      log(`Blocked number: ${phoneNumber}`);
      res.json({ success: true, message: 'Number blocked successfully' });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Block number error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Unblock a phone number
  app.post('/api/blocklist/remove', async (req, res) => {
    try {
      const { phoneNumber } = req.body;

      if (!phoneNumber) {
        return res.status(400).json({ success: false, error: 'Phone number is required' });
      }

      await storage.removeFromBlocklist(phoneNumber);

      log(`Unblocked number: ${phoneNumber}`);
      res.json({ success: true, message: 'Number unblocked successfully' });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Unblock number error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Check if number is blocked
  app.get('/api/blocklist/check/:phoneNumber', async (req, res) => {
    try {
      const { phoneNumber } = req.params;
      const isBlocked = await storage.isNumberBlocked(phoneNumber);

      res.json({ isBlocked });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Check blocklist error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Get all blocked numbers
  app.get('/api/blocklist', async (req, res) => {
    try {
      const blockedNumbers = await storage.getBlockedNumbers();
      res.json(blockedNumbers);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get blocklist error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Auto-response routes

  // Get all auto-responses (active only)
  app.get('/api/auto-responses', async (req, res) => {
    try {
      const autoResponses = await storage.getAutoResponses();
      res.json(autoResponses);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get auto-responses error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Get all auto-responses (including inactive)
  app.get('/api/auto-responses/all', async (req, res) => {
    try {
      const autoResponses = await withRetry(() => storage.getAllAutoResponses());
      res.json(autoResponses);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : '';
      log(`Get all auto-responses error: ${errorMessage}`);
      console.error('Full error:', error);
      console.error('Stack:', errorStack);
      res.status(500).json({ success: false, error: errorMessage || 'Failed to get auto-responses' });
    }
  });

  // Create new auto-response
  app.post('/api/auto-responses', async (req, res) => {
    try {
      const { keyword, response, isActive } = req.body;

      if (!keyword || !response) {
        return res.status(400).json({
          success: false,
          error: 'Keyword and response are required'
        });
      }

      const autoResponse = await withRetry(() => storage.createAutoResponse({
        keyword,
        response,
        isActive: isActive !== false, // Default to true
      }));

      res.json({ success: true, autoResponse });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : '';
      log(`Create auto-response error: ${errorMessage}`);
      console.error('Full error:', error);
      console.error('Stack:', errorStack);
      res.status(500).json({ success: false, error: errorMessage || 'Failed to create auto-response' });
    }
  });

  // Update auto-response
  app.put('/api/auto-responses/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { keyword, response, isActive } = req.body;

      const autoResponse = await withRetry(() => storage.updateAutoResponse(id, {
        keyword,
        response,
        isActive,
      }));

      if (!autoResponse) {
        return res.status(404).json({
          success: false,
          error: 'Auto-response not found'
        });
      }

      res.json({ success: true, autoResponse });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Update auto-response error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Delete auto-response
  app.delete('/api/auto-responses/:id', async (req, res) => {
    try {
      const { id } = req.params;
      await withRetry(() => storage.deleteAutoResponse(id));
      res.json({ success: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Delete auto-response error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Get recent incoming messages
  app.get('/api/incoming-messages', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const messages = await withRetry(() => storage.getMessages({
        type: 'incoming',
        limit,
      }));
      res.json(messages);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : '';
      log(`Get incoming messages error: ${errorMessage}`);
      console.error('Full error:', error);
      console.error('Stack:', errorStack);
      res.status(500).json({ success: false, error: errorMessage || 'Failed to get incoming messages' });
    }
  });

  // ==================== CHATBOT & LEADS API ====================

  // Get chatbot configuration
  app.get('/api/chatbot/config', async (req, res) => {
    try {
      const config = await withRetry(() => storage.getChatbotConfig());
      
      if (!config) {
        return res.json({
          success: true,
          config: null,
        });
      }

      // Mask the access key for security
      const maskedConfig = {
        ...config,
        ragAccessKey: config.ragAccessKey ? `${config.ragAccessKey.substring(0, 4)}...${config.ragAccessKey.substring(config.ragAccessKey.length - 4)}` : '',
      };

      res.json({
        success: true,
        config: maskedConfig,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get chatbot config error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Update chatbot configuration
  app.put('/api/chatbot/config', async (req, res) => {
    try {
      const validation = chatbotConfigSchema.safeParse(req.body);
      
      if (!validation.success) {
        return res.status(400).json({
          success: false,
          error: validation.error.errors[0].message,
        });
      }

      const { agentName, triggerKeywords, ragBaseUrl, ragAccessKey, contextMessageCount, isActive } = validation.data;

      const config = await withRetry(() => storage.updateChatbotConfig({
        agentName,
        triggerKeywords,
        ragBaseUrl,
        ragAccessKey,
        contextMessageCount,
        isActive,
      }));

      // Mask the access key in response
      const maskedConfig = {
        ...config,
        ragAccessKey: config.ragAccessKey ? `${config.ragAccessKey.substring(0, 4)}...${config.ragAccessKey.substring(config.ragAccessKey.length - 4)}` : '',
      };

      res.json({
        success: true,
        config: maskedConfig,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Update chatbot config error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Test chatbot RAG endpoint connection
  app.post('/api/chatbot/test', async (req, res) => {
    try {
      const config = await withRetry(() => storage.getChatbotConfig());
      
      if (!config) {
        return res.status(400).json({
          success: false,
          error: 'Chatbot not configured. Please save configuration first.',
        });
      }

      const chatbotService = new ChatbotService(storage, whatsAppService);
      const result = await chatbotService.testConnection(config);

      res.json(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Test chatbot connection error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        message: `Test failed: ${errorMessage}`,
      });
    }
  });

  // Get all leads
  app.get('/api/leads', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const leads = await withRetry(() => storage.getLeads({ limit, offset }));

      res.json({
        success: true,
        leads,
        count: leads.length,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get leads error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Get lead details with conversation
  app.get('/api/leads/:phoneNumber/conversation', async (req, res) => {
    try {
      const { phoneNumber } = req.params;
      const limit = parseInt(req.query.limit as string) || 20;

      const contact = await withRetry(() => storage.getContact(phoneNumber));
      const conversation = await withRetry(() => storage.getConversationHistory(phoneNumber, limit));

      res.json({
        success: true,
        contact,
        conversation: conversation.reverse(), // Return chronologically (oldest first)
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get lead conversation error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Manually flag a number as lead
  app.post('/api/leads/flag', async (req, res) => {
    try {
      const validation = flagLeadSchema.safeParse(req.body);
      
      if (!validation.success) {
        return res.status(400).json({
          success: false,
          error: validation.error.errors[0].message,
        });
      }

      const { phoneNumber, keyword, name } = validation.data;

      // Create chatbot service instance
      const chatbotService = new ChatbotService(storage, whatsAppService);

      // Use chatbot service to flag lead (sends greeting message automatically)
      const contact = await withRetry(() => chatbotService.flagAsLead(
        phoneNumber,
        keyword || 'Manual flag',
        name
      ));

      res.json({
        success: true,
        contact,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Flag lead error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Delete/unflag lead
  app.delete('/api/leads/:phoneNumber', async (req, res) => {
    try {
      const { phoneNumber } = req.params;

      // Unflag the contact (set isLead to false)
      await withRetry(() => storage.updateContact(phoneNumber, {
        isLead: 'false',
        leadTriggerKeyword: null,
      }));

      res.json({
        success: true,
        message: 'Lead removed successfully',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Delete lead error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Toggle chatbot active status for a lead
  app.patch('/api/leads/:phoneNumber/chatbot-status', async (req, res) => {
    try {
      const { phoneNumber } = req.params;
      const { active } = req.body;

      if (typeof active !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: 'active field must be a boolean',
        });
      }

      await withRetry(() => storage.updateContact(phoneNumber, {
        chatbotActive: active ? 'true' : 'false',
      }));

      res.json({
        success: true,
        message: `Chatbot ${active ? 'enabled' : 'paused'} for this lead`,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Toggle chatbot status error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // ==================== END CHATBOT & LEADS API ====================

  // ==================== HR ADMIN & HR CHATBOT API ====================

  // Get HR chatbot config
  app.get('/api/hr-chatbot/config', async (req, res) => {
    try {
      const config = await withRetry(() => storage.getHRChatbotConfig());

      if (!config) {
        return res.json({
          success: true,
          config: null,
          message: 'HR chatbot not configured yet',
        });
      }

      // Mask sensitive keys
      const maskedConfig = {
        ...config,
        ragAccessKey: config.ragAccessKey ? `${config.ragAccessKey.substring(0, 4)}...${config.ragAccessKey.substring(config.ragAccessKey.length - 4)}` : '',
        supabaseServiceKey: config.supabaseServiceKey ? '****' : '',
      };

      res.json({
        success: true,
        config: maskedConfig,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get HR chatbot config error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Update HR chatbot config
  app.put('/api/hr-chatbot/config', async (req, res) => {
    try {
      const validation = hrChatbotConfigSchema.safeParse(req.body);
      
      if (!validation.success) {
        return res.status(400).json({
          success: false,
          error: validation.error.errors[0].message,
        });
      }

      const config = await withRetry(() => storage.updateHRChatbotConfig({
        agentName: validation.data.agentName,
        ragBaseUrl: validation.data.ragBaseUrl,
        ragAccessKey: validation.data.ragAccessKey,
        supabaseUrl: validation.data.supabaseUrl,
        supabaseServiceKey: validation.data.supabaseServiceKey,
        contextMessageCount: validation.data.contextMessageCount,
        isActive: validation.data.isActive,
      }));

      // Mask sensitive keys in response
      const maskedConfig = {
        ...config,
        ragAccessKey: config.ragAccessKey ? `${config.ragAccessKey.substring(0, 4)}...****` : '',
        supabaseServiceKey: '****',
      };

      res.json({
        success: true,
        config: maskedConfig,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Update HR chatbot config error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Test HR chatbot connection
  app.post('/api/hr-chatbot/test', async (req, res) => {
    try {
      const config = await withRetry(() => storage.getHRChatbotConfig());
      
      if (!config) {
        return res.status(400).json({
          success: false,
          error: 'HR Chatbot not configured. Please save configuration first.',
        });
      }

      const hrChatbotService = new HRChatbotService(storage, whatsAppService);
      const result = await hrChatbotService.testConnection(config);

      res.json(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Test HR chatbot connection error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        message: `Test failed: ${errorMessage}`,
      });
    }
  });

  // Get all HR admins
  app.get('/api/hr-admins', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const hrAdmins = await withRetry(() => storage.getHRAdmins({ limit, offset }));

      res.json({
        success: true,
        hrAdmins,
        count: hrAdmins.length,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get HR admins error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Register new HR admin (link WhatsApp number to Task Management user)
  app.post('/api/hr-admins', async (req, res) => {
    try {
      const validation = registerHRAdminSchema.safeParse(req.body);
      
      if (!validation.success) {
        return res.status(400).json({
          success: false,
          error: validation.error.errors[0].message,
        });
      }

      const { phoneNumber, name, organizationId, userId, organizationName } = validation.data;

      // Create HR admin
      const hrAdmin = await withRetry(() => storage.createHRAdmin({
        phoneNumber,
        name,
        organizationId,
        userId,
        organizationName,
      }));

      // Optionally send welcome message
      try {
        const hrChatbotService = new HRChatbotService(storage, whatsAppService);
        await hrChatbotService.sendWelcomeMessage(hrAdmin);
      } catch (welcomeError) {
        console.log(`⚠️ Failed to send welcome message to HR admin: ${welcomeError}`);
      }

      res.json({
        success: true,
        hrAdmin,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Register HR admin error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Get HR admin details with conversation
  app.get('/api/hr-admins/:phoneNumber/conversation', async (req, res) => {
    try {
      const { phoneNumber } = req.params;
      const limit = parseInt(req.query.limit as string) || 20;

      const hrAdmin = await withRetry(() => storage.getHRAdmin(phoneNumber));
      const conversation = await withRetry(() => storage.getConversationHistory(phoneNumber, limit));

      res.json({
        success: true,
        hrAdmin,
        conversation: conversation.reverse(), // Return chronologically (oldest first)
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get HR admin conversation error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Delete HR admin
  app.delete('/api/hr-admins/:phoneNumber', async (req, res) => {
    try {
      const { phoneNumber } = req.params;

      await withRetry(() => storage.deleteHRAdmin(phoneNumber));

      res.json({
        success: true,
        message: 'HR admin removed successfully',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Delete HR admin error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Toggle HR chatbot active status for an admin
  app.patch('/api/hr-admins/:phoneNumber/chatbot-status', async (req, res) => {
    try {
      const { phoneNumber } = req.params;
      const { active } = req.body;

      if (typeof active !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: 'active field must be a boolean',
        });
      }

      await withRetry(() => storage.updateHRAdmin(phoneNumber, {
        chatbotActive: active ? 'true' : 'false',
      }));

      res.json({
        success: true,
        message: `HR Chatbot ${active ? 'enabled' : 'paused'} for this admin`,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Toggle HR chatbot status error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // ==================== END HR ADMIN API ====================

  // ==================== NOTIFICATION API ====================

  // Verify API key for notification endpoints
  const NOTIFICATION_API_KEY = process.env.NOTIFICATION_API_KEY || 'whatsapp-notification-secret-key';
  
  const verifyNotificationApiKey = (req: any, res: any): boolean => {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    if (apiKey !== NOTIFICATION_API_KEY) {
      res.status(401).json({ success: false, error: 'Invalid API key' });
      return false;
    }
    return true;
  };

  // Check if an organization is enabled for WhatsApp notifications
  app.get('/api/org-whatsapp-enabled/:organizationId', async (req, res) => {
    try {
      if (!verifyNotificationApiKey(req, res)) return;

      const { organizationId } = req.params;
      const orgAdmins = await storage.getHRAdminsByOrganization(organizationId);
      
      res.json({
        success: true,
        enabled: orgAdmins && orgAdmins.length > 0,
        adminCount: orgAdmins?.length || 0,
        organizationId,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Get all organizations enabled for WhatsApp
  app.get('/api/whatsapp-enabled-orgs', async (req, res) => {
    try {
      if (!verifyNotificationApiKey(req, res)) return;

      const allAdmins = await storage.getAllHRAdmins();
      
      // Group by organization
      const orgMap = new Map<string, { organizationId: string; adminCount: number }>();
      for (const admin of allAdmins) {
        const orgId = admin.organizationId;
        if (!orgMap.has(orgId)) {
          orgMap.set(orgId, { organizationId: orgId, adminCount: 0 });
        }
        orgMap.get(orgId)!.adminCount++;
      }

      res.json({
        success: true,
        organizations: Array.from(orgMap.values()),
        totalOrgs: orgMap.size,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Get HR admin's WhatsApp ID for a user (lookup by userId or phone)
  // This helps Task Management find the correct WhatsApp ID to send notifications
  app.get('/api/whatsapp-id-lookup', async (req, res) => {
    try {
      if (!verifyNotificationApiKey(req, res)) return;

      const { userId, organizationId, phoneNumber } = req.query;

      if (!organizationId) {
        return res.status(400).json({
          success: false,
          error: 'organizationId is required',
        });
      }

      // Get all HR admins for this org
      const orgAdmins = await storage.getHRAdminsByOrganization(organizationId as string);
      
      if (!orgAdmins || orgAdmins.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'No HR admins found for this organization',
        });
      }

      // If userId provided, try to find matching admin
      if (userId) {
        const matchingAdmin = orgAdmins.find(admin => admin.userId === userId);
        if (matchingAdmin) {
          return res.json({
            success: true,
            whatsappId: matchingAdmin.phoneNumber,
            isLid: matchingAdmin.phoneNumber.includes('@lid') || matchingAdmin.phoneNumber.length > 15,
            adminName: matchingAdmin.name,
          });
        }
      }

      // If phoneNumber provided, check if any admin matches
      if (phoneNumber) {
        const normalizedInput = (phoneNumber as string).replace(/[^0-9]/g, '');
        const matchingAdmin = orgAdmins.find(admin => {
          const adminPhone = admin.phoneNumber.replace(/[^0-9@]/g, '').split('@')[0];
          return adminPhone === normalizedInput || adminPhone.endsWith(normalizedInput);
        });
        
        if (matchingAdmin) {
          return res.json({
            success: true,
            whatsappId: matchingAdmin.phoneNumber,
            isLid: matchingAdmin.phoneNumber.includes('@lid') || matchingAdmin.phoneNumber.length > 15,
            adminName: matchingAdmin.name,
          });
        }
      }

      // Return first admin as default (org-level notification)
      const defaultAdmin = orgAdmins[0];
      res.json({
        success: true,
        whatsappId: defaultAdmin.phoneNumber,
        isLid: defaultAdmin.phoneNumber.includes('@lid') || defaultAdmin.phoneNumber.length > 15,
        adminName: defaultAdmin.name,
        note: 'Default org admin (no specific user match)',
        allAdmins: orgAdmins.map(a => ({ 
          userId: a.userId, 
          name: a.name, 
          phoneNumber: a.phoneNumber 
        })),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Send notification via WhatsApp (called by Supabase edge function)
  app.post('/api/send-notification', async (req, res) => {
    try {
      // Verify API key
      if (!verifyNotificationApiKey(req, res)) return;

      const { phoneNumber, message, notificationId, title, type, organizationId } = req.body;

      if (!phoneNumber || !message) {
        return res.status(400).json({
          success: false,
          error: 'phoneNumber and message are required',
        });
      }

      // REQUIRED: Check if organization has any HR admin registered
      // Only orgs with HR admins can receive WhatsApp notifications
      if (!organizationId) {
        return res.status(400).json({
          success: false,
          error: 'organizationId is required',
        });
      }

      const orgAdmins = await storage.getHRAdminsByOrganization(organizationId);
      if (!orgAdmins || orgAdmins.length === 0) {
        log(`🚫 Org ${organizationId} not enabled for WhatsApp - no HR admins registered`);
        return res.status(403).json({
          success: false,
          error: 'Organization not enabled for WhatsApp notifications. Register an HR admin first.',
          organizationId,
        });
      }

      log(`✅ Org ${organizationId} verified - ${orgAdmins.length} HR admin(s) registered`);

      // Smart phone number normalization - handles both regular and LID formats
      let normalizedPhone = phoneNumber;
      
      // Check if it's already a full JID (contains @)
      if (phoneNumber.includes('@')) {
        normalizedPhone = phoneNumber; // Already formatted
      } else if (phoneNumber.length > 15) {
        // Long numbers are likely LID format
        normalizedPhone = `${phoneNumber.replace(/[^0-9]/g, '')}@lid`;
      } else {
        // Regular phone number
        normalizedPhone = `${phoneNumber.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
      }

      log(`📤 Sending notification to ${normalizedPhone}: ${message.substring(0, 50)}...`);

      // Format message with title if provided
      const formattedMessage = title 
        ? `*${title}*\n\n${message}`
        : message;

      // Send via WhatsApp
      await whatsAppService.sendMessage(normalizedPhone, formattedMessage);

      log(`✅ Notification sent successfully (id: ${notificationId || 'N/A'})`);

      res.json({
        success: true,
        message: 'Notification sent',
        notificationId,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`❌ Send notification error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Batch send notifications (for processing queue)
  app.post('/api/send-notifications-batch', async (req, res) => {
    try {
      // Verify API key
      if (!verifyNotificationApiKey(req, res)) return;

      const { notifications } = req.body;

      if (!Array.isArray(notifications) || notifications.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'notifications array is required',
        });
      }

      log(`📤 Processing batch of ${notifications.length} notifications`);

      const results = {
        sent: 0,
        failed: 0,
        errors: [] as { notificationId: string; error: string }[],
      };

      for (const notification of notifications) {
        try {
          const { phoneNumber, message, notificationId, title } = notification;
          
          if (!phoneNumber || !message) {
            results.failed++;
            results.errors.push({ notificationId, error: 'Missing phoneNumber or message' });
            continue;
          }

          // Smart phone number normalization - handles both regular and LID formats
          let normalizedPhone = phoneNumber;
          if (phoneNumber.includes('@')) {
            normalizedPhone = phoneNumber; // Already formatted
          } else if (phoneNumber.length > 15) {
            // Long numbers are likely LID format
            normalizedPhone = `${phoneNumber.replace(/[^0-9]/g, '')}@lid`;
          } else {
            // Regular phone number
            normalizedPhone = `${phoneNumber.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
          }

          const formattedMessage = title 
            ? `*${title}*\n\n${message}`
            : message;

          await whatsAppService.sendMessage(normalizedPhone, formattedMessage);
          results.sent++;

          // Small delay between messages to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          results.failed++;
          results.errors.push({ 
            notificationId: notification.notificationId, 
            error: error instanceof Error ? error.message : 'Unknown error' 
          });
        }
      }

      log(`✅ Batch complete: ${results.sent} sent, ${results.failed} failed`);

      res.json({
        success: true,
        results,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`❌ Batch notification error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // ==================== END NOTIFICATION API ====================

  // Cleanup old files periodically
  setInterval(async () => {
    await fileService.cleanupOldFiles(24); // Clean files older than 24 hours
  }, 60 * 60 * 1000); // Run every hour

  return httpServer;
}
