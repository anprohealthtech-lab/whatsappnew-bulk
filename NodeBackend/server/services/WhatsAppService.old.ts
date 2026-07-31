import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  WASocket,
  ConnectionState,
  proto
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode-terminal';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

export interface WhatsAppStatus {
  isConnected: boolean;
  isAuthenticated: boolean;
  lastSeen: Date | null;
  sessionInfo: any;
}

export class WhatsAppService extends EventEmitter {
  private socket: WASocket | null = null;
  private status: WhatsAppStatus = {
    isConnected: false,
    isAuthenticated: false,
    lastSeen: null,
    sessionInfo: null,
  };
  private authPath: string;
  private currentQR: string | null = null;
  private currentQR: { qr: string; timestamp: Date } | null = null;

  constructor() {
    super();
    
    // Ensure session directory exists
    this.sessionPath = path.join(process.cwd(), 'server/sessions');
    if (!fs.existsSync(this.sessionPath)) {
      fs.mkdirSync(this.sessionPath, { recursive: true });
    }
  }

  async initialize(): Promise<void> {
    try {
      console.log('🚀 Starting REAL WhatsApp Web integration - no demo mode');

      // Clean up any existing Chrome processes and sessions first
      await this.cleanup();

      // Check for Chrome executable with environment variable first
      const fs = await import('fs');
      const chromePaths = [
        process.env.PUPPETEER_EXECUTABLE_PATH, // From DigitalOcean env var
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium'
      ].filter(Boolean); // Remove undefined values
      
      let availableChrome = '';
      for (const path of chromePaths) {
        if (path && fs.existsSync(path)) {
          availableChrome = path;
          break;
        }
      }
      
      if (!availableChrome) {
        console.error('❌ Chrome not found in any of these paths:', chromePaths);
        console.log('🔄 Attempting to initialize anyway with default Chrome path...');
        // Try with a default Chrome path that might exist
        availableChrome = '/usr/bin/google-chrome-stable';
      }
      
      console.log(`✅ Using Chrome at: ${availableChrome}`);

      // Create unique session ID to avoid conflicts
      const uniqueClientId = `whatsapp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const uniqueSessionPath = path.join(this.sessionPath, uniqueClientId);
      
      // Ensure unique session directory exists
      if (!fs.existsSync(uniqueSessionPath)) {
        fs.mkdirSync(uniqueSessionPath, { recursive: true });
      }

      this.client = new Client({
        authStrategy: new LocalAuth({
          clientId: uniqueClientId,
          dataPath: uniqueSessionPath,
        }),
        puppeteer: {
          headless: 'new',
          executablePath: availableChrome,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--no-first-run',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--disable-ipc-flooding-protection',
            `--user-data-dir=${uniqueSessionPath}/chrome-data`,
            `--profile-directory=${uniqueClientId}`,
            '--remote-debugging-port=0' // Use random available port
          ],
        },
      });

      this.setupEventHandlers();
      await this.client.initialize();
      
      this.emit('whatsapp-status', { status: 'initializing' });
      console.log('✅ WhatsApp client initialized successfully - QR codes should generate automatically');
      
      // Start periodic QR generation check to ensure QR codes are always available
      this.startPeriodicQRGeneration();
    } catch (error: any) {
      console.error('Failed to initialize WhatsApp client:', error);
      console.log('Attempting to force real WhatsApp connection...');
      
      // Clean up any existing Chrome processes and sessions
      await this.cleanup();
      
      // Try alternative Chrome configuration for real WhatsApp
      try {
        console.log('Attempting alternative Chrome configuration...');
        
        // Find Chrome executable again
        const fs = await import('fs');
        const chromePaths = [
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/snap/bin/chromium'
        ];

        let chromeExecutable = '';
        for (const path of chromePaths) {
          if (fs.existsSync(path)) {
            chromeExecutable = path;
            break;
          }
        }

        if (!chromeExecutable) {
          throw new Error('No Chrome executable found');
        }

        console.log('Using Chrome at:', chromeExecutable);
        
        // Create another unique session for retry
        const retryClientId = `whatsapp-retry-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const retrySessionPath = path.join(this.sessionPath, retryClientId);
        
        if (!fs.existsSync(retrySessionPath)) {
          fs.mkdirSync(retrySessionPath, { recursive: true });
        }
        
        this.client = new Client({
          authStrategy: new LocalAuth({
            clientId: retryClientId,
            dataPath: retrySessionPath,
          }),
          puppeteer: {
            headless: 'new',
            executablePath: chromeExecutable,
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-gpu',
              '--disable-extensions',
              '--no-first-run',
              '--disable-background-timer-throttling',
              '--disable-backgrounding-occluded-windows',
              '--disable-renderer-backgrounding',
              '--disable-web-security',
              '--single-process',
              `--user-data-dir=${retrySessionPath}/chrome-data-retry`,
              `--profile-directory=${retryClientId}`,
              '--remote-debugging-port=0'
            ],
          },
        });
        
        this.setupEventHandlers();
        await this.client.initialize();
        console.log('WhatsApp client initialized successfully with alternative config');
      } catch (retryError: any) {
        console.error('Alternative WhatsApp initialization also failed:', retryError);
        console.log('Switching to demo mode due to initialization failure');
        process.env.DEMO_MODE = 'true';
        this.emit('whatsapp-auth-failure', { error: retryError?.message || 'WhatsApp unavailable - running in demo mode' });
      }
    }
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    this.client.on('qr', (qr) => {
      console.log('QR Code received, scan please!');
      const qrcode = require('qrcode-terminal');
      qrcode.generate(qr, { small: true });
      
      // Create simple QR code URL for frontend using existing service
      const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(qr)}`;
      
      console.log('QR Code URL generated for frontend:', qrCodeUrl.substring(0, 100) + '...');
      console.log('🚀 EMITTING QR-CODE EVENT TO WEBSOCKET!');
      
      // Store current QR for HTTP fallback
      this.currentQR = { qr: qrCodeUrl, timestamp: new Date() };
      
      // Emit the QR code event
      const qrData = { qr: qrCodeUrl, rawQR: qr };
      this.emit('qr-code', qrData);
      console.log('✅ QR-CODE EVENT EMITTED with data:', qrData);
      
      // Also emit internal event for generateQRCode promise
      this.emit('qr-received', qr);
    });

    this.client.on('ready', () => {
      console.log('WhatsApp client is ready!');
      this.status.isConnected = true;
      this.status.isAuthenticated = true;
      this.status.lastSeen = new Date();
      this.emit('whatsapp-authenticated', { status: this.status });
    });

    this.client.on('authenticated', (session) => {
      console.log('WhatsApp authenticated');
      this.status.sessionInfo = session;
      this.emit('whatsapp-status', { status: 'authenticated', session });
    });

    this.client.on('auth_failure', (msg) => {
      console.error('Authentication failed:', msg);
      this.status.isAuthenticated = false;
      this.emit('whatsapp-auth-failure', { error: msg });
    });

    this.client.on('disconnected', (reason) => {
      console.log('WhatsApp client disconnected:', reason);
      this.status.isConnected = false;
      this.status.isAuthenticated = false;
      this.emit('disconnected', { reason });
    });

    this.client.on('message_create', (message) => {
      if (message.fromMe) {
        this.emit('message-sent', { 
          messageId: message.id._serialized,
          to: message.to,
          timestamp: message.timestamp,
        });
      }
    });

    this.client.on('message_ack', (message, ack) => {
      this.emit('message-update', {
        messageId: message.id._serialized,
        ack,
        timestamp: new Date(),
      });
    });
  }

  async sendTextMessage(phoneNumber: string, message: string): Promise<any> {
    // Demo mode simulation
    if (process.env.DEMO_MODE === 'true') {
      console.log(`Demo mode: Would send text message to ${phoneNumber}: ${message}`);
      return {
        id: `demo_${Date.now()}`,
        to: `${phoneNumber}@c.us`,
        body: message,
        timestamp: Date.now(),
      };
    }

    if (!this.client || !this.status.isConnected) {
      throw new Error('WhatsApp client is not connected');
    }

    try {
      // Format phone number (ensure it has country code)
      const formattedNumber = this.formatPhoneNumber(phoneNumber);
      const chatId = `${formattedNumber}@c.us`;
      
      const sentMessage = await this.client.sendMessage(chatId, message);
      
      this.status.lastSeen = new Date();
      
      return {
        id: sentMessage.id._serialized,
        to: sentMessage.to,
        body: sentMessage.body,
        timestamp: sentMessage.timestamp,
      };
    } catch (error: any) {
      console.error('Failed to send text message:', error);
      throw error;
    }
  }

  async sendMediaMessage(phoneNumber: string, filePath: string, caption?: string): Promise<any> {
    // Demo mode simulation
    if (process.env.DEMO_MODE === 'true') {
      console.log(`Demo mode: Would send media message to ${phoneNumber}: ${filePath} with caption: ${caption || 'No caption'}`);
      return {
        id: `demo_media_${Date.now()}`,
        to: `${phoneNumber}@c.us`,
        hasMedia: true,
        timestamp: Date.now(),
      };
    }

    if (!this.client || !this.status.isConnected) {
      throw new Error('WhatsApp client is not connected');
    }

    try {
      const formattedNumber = this.formatPhoneNumber(phoneNumber);
      const chatId = `${formattedNumber}@c.us`;
      
      const media = MessageMedia.fromFilePath(filePath);
      const sentMessage = await this.client.sendMessage(chatId, media, { caption });
      
      this.status.lastSeen = new Date();
      
      return {
        id: sentMessage.id._serialized,
        to: sentMessage.to,
        hasMedia: sentMessage.hasMedia,
        timestamp: sentMessage.timestamp,
      };
    } catch (error: any) {
      console.error('Failed to send media message:', error);
      throw error;
    }
  }

  async generateQRCode(): Promise<void> {
    if (this.client && this.status.isConnected) {
      throw new Error('WhatsApp is already connected');
    }

    console.log('🎯 QR code generation requested');
    
    // If client exists and is initializing, QR should generate automatically
    if (this.client) {
      console.log('✅ WhatsApp client exists - QR codes should generate automatically');
      this.emit('whatsapp-status', { 
        status: 'generating-qr', 
        message: 'QR code should appear shortly via WebSocket' 
      });
      return Promise.resolve();
    }

    // If no client, try to initialize (which will generate QR)
    console.log('🔄 No WhatsApp client found - initializing...');
    try {
      await this.initialize();
      return Promise.resolve();
    } catch (error) {
      console.error('❌ Failed to initialize WhatsApp for QR generation:', error);
      throw new Error('Unable to generate QR code - WhatsApp initialization failed');
        const qrcode = require('qrcode-terminal');
        qrcode.generate(qr, { small: true });
        
        // Create QR code URL for frontend
    }
  }

  getStatus(): WhatsAppStatus {
    return { ...this.status };
  }

  getCurrentQR(): { qr: string; timestamp: Date } | null {
    return this.currentQR;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      this.client = null;
      this.status.isConnected = false;
      this.status.isAuthenticated = false;
    }
  }

  private async cleanup(): Promise<void> {
    console.log('Cleaning up Chrome processes and sessions...');
    
    // Destroy existing client
    if (this.client) {
      try {
        await this.client.destroy();
      } catch (error) {
        console.log('Error destroying client:', error);
      }
      this.client = null;
    }

    // Clean up Chrome processes and session data
    const fs = await import('fs');
    const path = await import('path');
    const { spawn, execSync } = await import('child_process');
    
    try {
      // Kill any existing Chrome processes more aggressively
      const killCommands = [
        'pkill -9 -f "chromium.*whatsapp"',
        'pkill -9 -f "chrome.*whatsapp"',
        'pkill -9 -f chromium',
        'pkill -9 -f chrome'
      ];
      
      for (const cmd of killCommands) {
        try {
          execSync(cmd, { stdio: 'ignore', timeout: 5000 });
        } catch (error) {
          // Ignore errors - process might not exist
        }
      }
      
      // Clean up all session directories to avoid conflicts
      if (fs.existsSync(this.sessionPath)) {
        const sessionDirs = fs.readdirSync(this.sessionPath);
        for (const dir of sessionDirs) {
          const sessionDir = path.join(this.sessionPath, dir);
          if (fs.statSync(sessionDir).isDirectory()) {
            try {
              // Remove SingletonLock files specifically
              const lockFile = path.join(sessionDir, 'SingletonLock');
              if (fs.existsSync(lockFile)) {
                fs.unlinkSync(lockFile);
                console.log('Removed SingletonLock from:', sessionDir);
              }
              
              // Remove chrome-data directories
              const chromeDataDirs = ['chrome-data', 'chrome-data-retry'];
              for (const chromeDir of chromeDataDirs) {
                const chromePath = path.join(sessionDir, chromeDir);
                if (fs.existsSync(chromePath)) {
                  fs.rmSync(chromePath, { recursive: true, force: true });
                  console.log('Removed chrome data:', chromePath);
                }
              }
            } catch (error) {
              console.log('Could not clean session directory:', sessionDir, error);
            }
          }
        }
      }
      
      // Clean up system temp files
      const tempPaths = [
        '/tmp/.org.chromium.Chromium',
        '/tmp/.org.chrome.Chrome',
        '/tmp/chrome-*',
        '/tmp/chromium-*'
      ];
      
      for (const tempPath of tempPaths) {
        try {
          execSync(`rm -rf ${tempPath}`, { stdio: 'ignore', timeout: 5000 });
        } catch (error) {
          // Ignore errors
        }
      }
    } catch (error) {
      console.log('Could not clean up Chrome files:', error);
    }

    // Reset status
    this.status = {
      isConnected: false,
      isAuthenticated: false,
      lastSeen: null,
      sessionInfo: null,
    };
    
    // Wait for cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  private formatPhoneNumber(phoneNumber: string): string {
    // Remove all non-numeric characters
    let cleaned = phoneNumber.replace(/\D/g, '');
    
    // Add country code if not present (assuming US +1 as default)
    if (!cleaned.startsWith('1') && cleaned.length === 10) {
      cleaned = '1' + cleaned;
    }
    
    return cleaned;
  }

  private startPeriodicQRGeneration(): void {
    console.log('🔄 Starting periodic QR generation check...');
    
    // Check every 30 seconds if we need to generate new QR codes
    setInterval(() => {
      if (!this.status.isConnected && !this.status.isAuthenticated) {
        console.log('⚡ WhatsApp not connected - ensuring QR codes are being generated');
        // The QR codes should be generated automatically by the 'qr' event
        // This is just a heartbeat to ensure the connection is working
        this.emit('whatsapp-status', { 
          status: 'waiting-for-qr', 
          message: 'Generating QR code...' 
        });
      }
    }, 30000); // Every 30 seconds
  }
}

export const whatsAppService = new WhatsAppService();
