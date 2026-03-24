import { type User, type InsertUser, type Message, type InsertMessage, type SystemLog, type InsertSystemLog, type BlockedNumber, type AutoResponse, type Contact, type HRAdmin, type HRChatbotConfig } from "@shared/schema";
import { randomUUID } from "crypto";

export interface TenantFilter {
  organizationId: string;
  userId: string;
}

export interface IStorage {
  // User methods
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  // Message methods
  getMessage(id: string): Promise<Message | undefined>;
  getMessages(filters?: { status?: string; phoneNumber?: string; type?: string; limit?: number; offset?: number }): Promise<Message[]>;
  createMessage(message: InsertMessage): Promise<Message>;
  createMessageForTenant(tenant: TenantFilter, message: InsertMessage): Promise<Message>;
  updateMessage(id: string, updates: Partial<Message>): Promise<Message | undefined>;
  getMessagesCount(filters?: { status?: string; phoneNumber?: string; type?: string }): Promise<number>;
  getMessagesByDateRange(startDate: Date, endDate: Date): Promise<Message[]>;

  // System log methods
  getSystemLogs(limit?: number, offset?: number): Promise<SystemLog[]>;
  createSystemLog(log: InsertSystemLog): Promise<SystemLog>;

  // Blocklist methods
  addToBlocklist(phoneNumber: string, reason?: string): Promise<BlockedNumber>;
  removeFromBlocklist(phoneNumber: string): Promise<void>;
  isNumberBlocked(phoneNumber: string): Promise<boolean>;
  getBlockedNumbers(): Promise<BlockedNumber[]>;
  getBlockedNumber(phoneNumber: string): Promise<BlockedNumber | undefined>;
  addToBlocklistForTenant(tenant: TenantFilter, phoneNumber: string, reason?: string): Promise<BlockedNumber>;
  removeFromBlocklistForTenant(tenant: TenantFilter, phoneNumber: string): Promise<void>;
  isNumberBlockedForTenant(tenant: TenantFilter, phoneNumber: string): Promise<boolean>;
  getBlockedNumbersByTenant(tenant: TenantFilter): Promise<BlockedNumber[]>;
  getBlockedNumberByTenant(tenant: TenantFilter, phoneNumber: string): Promise<BlockedNumber | undefined>;

  // Auto-response methods
  getAutoResponses(): Promise<AutoResponse[]>;
  getAllAutoResponses(): Promise<AutoResponse[]>;
  createAutoResponse(data: { keyword: string; response: string; isActive?: boolean }): Promise<AutoResponse>;
  updateAutoResponse(id: string, data: { keyword?: string; response?: string; isActive?: boolean }): Promise<AutoResponse | undefined>;
  deleteAutoResponse(id: string): Promise<void>;
  getAutoResponsesByTenant(tenant: TenantFilter): Promise<AutoResponse[]>;
  getAllAutoResponsesByTenant(tenant: TenantFilter): Promise<AutoResponse[]>;
  createAutoResponseForTenant(tenant: TenantFilter, data: { keyword: string; response: string; isActive?: boolean }): Promise<AutoResponse>;
  updateAutoResponseForTenant(tenant: TenantFilter, id: string, data: { keyword?: string; response?: string; isActive?: boolean }): Promise<AutoResponse | undefined>;
  deleteAutoResponseForTenant(tenant: TenantFilter, id: string): Promise<void>;

  // Contact/Lead methods
  flagAsLead(phoneNumber: string, keyword: string, name?: string): Promise<Contact>;
  isLead(phoneNumber: string): Promise<boolean>;
  getLeads(filters?: { limit?: number; offset?: number }): Promise<Contact[]>;
  getContact(phoneNumber: string): Promise<Contact | undefined>;
  updateContact(phoneNumber: string, updates: Partial<Contact>): Promise<Contact | undefined>;
  getConversationHistory(phoneNumber: string, limit?: number): Promise<Message[]>;
  flagAsLeadForTenant(tenant: TenantFilter, phoneNumber: string, keyword: string, name?: string): Promise<Contact>;
  isLeadForTenant(tenant: TenantFilter, phoneNumber: string): Promise<boolean>;
  getLeadsByTenant(tenant: TenantFilter, filters?: { limit?: number; offset?: number }): Promise<Contact[]>;
  getContactsByTenant(tenant: TenantFilter, filters?: { limit?: number; offset?: number }): Promise<Contact[]>;
  getContactByTenant(tenant: TenantFilter, phoneNumber: string): Promise<Contact | undefined>;
  updateContactByTenant(tenant: TenantFilter, phoneNumber: string, updates: Partial<Contact>): Promise<Contact | undefined>;
  getConversationHistoryByTenant(tenant: TenantFilter, phoneNumber: string, limit?: number): Promise<Message[]>;

  // HR Admin methods
  getHRAdmin(phoneNumber: string): Promise<HRAdmin | undefined>;
  getHRAdmins(filters?: { limit?: number; offset?: number }): Promise<HRAdmin[]>;
  getAllHRAdmins(): Promise<HRAdmin[]>;
  getHRAdminsByOrganization(organizationId: string): Promise<HRAdmin[]>;
  createHRAdmin(data: { phoneNumber: string; name?: string; organizationId: string; userId: string; organizationName?: string }): Promise<HRAdmin>;
  updateHRAdmin(phoneNumber: string, updates: Partial<HRAdmin>): Promise<HRAdmin | undefined>;
  deleteHRAdmin(phoneNumber: string): Promise<void>;
  isHRAdmin(phoneNumber: string): Promise<boolean>;

  // HR Chatbot config methods
  getHRChatbotConfig(): Promise<HRChatbotConfig | undefined>;
  updateHRChatbotConfig(config: Partial<HRChatbotConfig> & { agentName: string }): Promise<HRChatbotConfig>;
}

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private messages: Map<string, Message>;
  private systemLogs: Map<string, SystemLog>;

  constructor() {
    this.users = new Map();
    this.messages = new Map();
    this.systemLogs = new Map();
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const user: User = { ...insertUser, id };
    this.users.set(id, user);
    return user;
  }

  async getMessage(id: string): Promise<Message | undefined> {
    return this.messages.get(id);
  }

  async getMessages(filters?: { status?: string; phoneNumber?: string; type?: string; limit?: number; offset?: number }): Promise<Message[]> {
    let messages = Array.from(this.messages.values());

    if (filters?.status) {
      messages = messages.filter(msg => msg.status === filters.status);
    }
    if (filters?.phoneNumber) {
      messages = messages.filter(msg => msg.phoneNumber === filters.phoneNumber);
    }
    if (filters?.type) {
      messages = messages.filter(msg => msg.type === filters.type);
    }

    // Sort by creation date (newest first)
    messages.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });

    const offset = filters?.offset || 0;
    const limit = filters?.limit || messages.length;
    
    return messages.slice(offset, offset + limit);
  }

  async createMessage(insertMessage: InsertMessage): Promise<Message> {
    const id = randomUUID();
    const message: Message = {
      ...insertMessage,
      id,
      metadata: insertMessage.metadata || null,
      createdAt: new Date(),
      sentAt: null,
      deliveredAt: null,
    };
    this.messages.set(id, message);
    return message;
  }

  async createMessageForTenant(_tenant: TenantFilter, insertMessage: InsertMessage): Promise<Message> {
    return this.createMessage(insertMessage);
  }

  async updateMessage(id: string, updates: Partial<Message>): Promise<Message | undefined> {
    const existing = this.messages.get(id);
    if (!existing) return undefined;

    const updated = { ...existing, ...updates };
    this.messages.set(id, updated);
    return updated;
  }

  async getMessagesCount(filters?: { status?: string; phoneNumber?: string; type?: string }): Promise<number> {
    const messages = await this.getMessages(filters);
    return messages.length;
  }

  async getMessagesByDateRange(startDate: Date, endDate: Date): Promise<Message[]> {
    return Array.from(this.messages.values()).filter(msg => {
      if (!msg.createdAt) return false;
      const msgDate = new Date(msg.createdAt);
      return msgDate >= startDate && msgDate <= endDate;
    });
  }

  async getSystemLogs(limit = 50, offset = 0): Promise<SystemLog[]> {
    const logs = Array.from(this.systemLogs.values());
    logs.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });
    
    return logs.slice(offset, offset + limit);
  }

  async createSystemLog(insertLog: InsertSystemLog): Promise<SystemLog> {
    const id = randomUUID();
    const log: SystemLog = {
      ...insertLog,
      id,
      metadata: insertLog.metadata || null,
      createdAt: new Date(),
    };
    this.systemLogs.set(id, log);
    return log;
  }

  // Blocklist methods (MemStorage implementation)
  private blockedNumbers: Map<string, BlockedNumber> = new Map();

  async addToBlocklist(phoneNumber: string, reason: string = 'user_requested'): Promise<BlockedNumber> {
    const cleanedNumber = phoneNumber.replace(/\D/g, '');
    const blocked: BlockedNumber = {
      id: randomUUID(),
      phoneNumber: cleanedNumber,
      reason,
      blockedAt: new Date(),
    };
    this.blockedNumbers.set(cleanedNumber, blocked);
    return blocked;
  }

  async removeFromBlocklist(phoneNumber: string): Promise<void> {
    const cleanedNumber = phoneNumber.replace(/\D/g, '');
    this.blockedNumbers.delete(cleanedNumber);
  }

  async isNumberBlocked(phoneNumber: string): Promise<boolean> {
    const cleanedNumber = phoneNumber.replace(/\D/g, '');
    return this.blockedNumbers.has(cleanedNumber);
  }

  async getBlockedNumbers(): Promise<BlockedNumber[]> {
    return Array.from(this.blockedNumbers.values());
  }

  async getBlockedNumber(phoneNumber: string): Promise<BlockedNumber | undefined> {
    const cleanedNumber = phoneNumber.replace(/\D/g, '');
    return this.blockedNumbers.get(cleanedNumber);
  }

  async addToBlocklistForTenant(_tenant: TenantFilter, phoneNumber: string, reason: string = 'user_requested'): Promise<BlockedNumber> {
    return this.addToBlocklist(phoneNumber, reason);
  }

  async removeFromBlocklistForTenant(_tenant: TenantFilter, phoneNumber: string): Promise<void> {
    await this.removeFromBlocklist(phoneNumber);
  }

  async isNumberBlockedForTenant(_tenant: TenantFilter, phoneNumber: string): Promise<boolean> {
    return this.isNumberBlocked(phoneNumber);
  }

  async getBlockedNumbersByTenant(_tenant: TenantFilter): Promise<BlockedNumber[]> {
    return this.getBlockedNumbers();
  }

  async getBlockedNumberByTenant(_tenant: TenantFilter, phoneNumber: string): Promise<BlockedNumber | undefined> {
    return this.getBlockedNumber(phoneNumber);
  }

  // Auto-response methods (MemStorage implementation)
  private autoResponses: Map<string, AutoResponse> = new Map();

  async getAutoResponses(): Promise<AutoResponse[]> {
    return Array.from(this.autoResponses.values()).filter(ar => ar.isActive === 'true');
  }

  async getAllAutoResponses(): Promise<AutoResponse[]> {
    return Array.from(this.autoResponses.values());
  }

  async createAutoResponse(data: { keyword: string; response: string; isActive?: boolean }): Promise<AutoResponse> {
    const id = randomUUID();
    const autoResponse: AutoResponse = {
      id,
      keyword: data.keyword,
      response: data.response,
      isActive: data.isActive === false ? 'false' : 'true',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.autoResponses.set(id, autoResponse);
    return autoResponse;
  }

  async updateAutoResponse(
    id: string,
    data: { keyword?: string; response?: string; isActive?: boolean }
  ): Promise<AutoResponse | undefined> {
    const existing = this.autoResponses.get(id);
    if (!existing) return undefined;

    const updated: AutoResponse = {
      ...existing,
      keyword: data.keyword !== undefined ? data.keyword : existing.keyword,
      response: data.response !== undefined ? data.response : existing.response,
      isActive: data.isActive !== undefined ? (data.isActive ? 'true' : 'false') : existing.isActive,
      updatedAt: new Date(),
    };
    
    this.autoResponses.set(id, updated);
    return updated;
  }

  async deleteAutoResponse(id: string): Promise<void> {
    this.autoResponses.delete(id);
  }

  async getAutoResponsesByTenant(_tenant: TenantFilter): Promise<AutoResponse[]> {
    return this.getAutoResponses();
  }

  async getAllAutoResponsesByTenant(_tenant: TenantFilter): Promise<AutoResponse[]> {
    return this.getAllAutoResponses();
  }

  async createAutoResponseForTenant(_tenant: TenantFilter, data: { keyword: string; response: string; isActive?: boolean }): Promise<AutoResponse> {
    return this.createAutoResponse(data);
  }

  async updateAutoResponseForTenant(_tenant: TenantFilter, id: string, data: { keyword?: string; response?: string; isActive?: boolean }): Promise<AutoResponse | undefined> {
    return this.updateAutoResponse(id, data);
  }

  async deleteAutoResponseForTenant(_tenant: TenantFilter, id: string): Promise<void> {
    await this.deleteAutoResponse(id);
  }

  // Contact/Lead methods (MemStorage stub implementations)
  private contacts: Map<string, Contact> = new Map();

  async flagAsLead(phoneNumber: string, keyword: string, name?: string): Promise<Contact> {
    const existing = Array.from(this.contacts.values()).find(c => c.phoneNumber === phoneNumber);
    
    if (existing) {
      const updated: Contact = {
        ...existing,
        isLead: 'true',
        leadTriggerKeyword: keyword,
        lastMessageAt: new Date(),
        updatedAt: new Date(),
        name: name || existing.name,
      };
      this.contacts.set(existing.id, updated);
      return updated;
    } else {
      const id = randomUUID();
      const contact: Contact = {
        id,
        phoneNumber,
        name: name || null,
        isLead: 'true',
        leadTriggerKeyword: keyword,
        conversationState: null,
        lastMessageAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.contacts.set(id, contact);
      return contact;
    }
  }

  async isLead(phoneNumber: string): Promise<boolean> {
    const contact = Array.from(this.contacts.values()).find(c => c.phoneNumber === phoneNumber);
    return contact?.isLead === 'true';
  }

  async getLeads(filters?: { limit?: number; offset?: number }): Promise<Contact[]> {
    const leads = Array.from(this.contacts.values())
      .filter(c => c.isLead === 'true')
      .sort((a, b) => {
        const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
        const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
        return bTime - aTime;
      });

    const offset = filters?.offset || 0;
    const limit = filters?.limit || leads.length;
    
    return leads.slice(offset, offset + limit);
  }

  async getContact(phoneNumber: string): Promise<Contact | undefined> {
    return Array.from(this.contacts.values()).find(c => c.phoneNumber === phoneNumber);
  }

  async updateContact(phoneNumber: string, updates: Partial<Contact>): Promise<Contact | undefined> {
    const contact = Array.from(this.contacts.values()).find(c => c.phoneNumber === phoneNumber);
    if (!contact) return undefined;

    const updated: Contact = {
      ...contact,
      ...updates,
      updatedAt: new Date(),
    };
    
    this.contacts.set(contact.id, updated);
    return updated;
  }

  async getConversationHistory(phoneNumber: string, limit: number = 10): Promise<Message[]> {
    const messages = await this.getMessages({
      phoneNumber,
      limit,
    });

    return messages.filter(msg => msg.type === 'incoming' || msg.type === 'text');
  }

  async flagAsLeadForTenant(_tenant: TenantFilter, phoneNumber: string, keyword: string, name?: string): Promise<Contact> {
    return this.flagAsLead(phoneNumber, keyword, name);
  }

  async isLeadForTenant(_tenant: TenantFilter, phoneNumber: string): Promise<boolean> {
    return this.isLead(phoneNumber);
  }

  async getLeadsByTenant(_tenant: TenantFilter, filters?: { limit?: number; offset?: number }): Promise<Contact[]> {
    return this.getLeads(filters);
  }

  async getContactsByTenant(_tenant: TenantFilter, filters?: { limit?: number; offset?: number }): Promise<Contact[]> {
    let contacts = Array.from(this.contacts.values());
    contacts.sort((a, b) => {
      const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return bTime - aTime;
    });
    const offset = filters?.offset || 0;
    const limit = filters?.limit || contacts.length;
    return contacts.slice(offset, offset + limit);
  }

  async getContactByTenant(_tenant: TenantFilter, phoneNumber: string): Promise<Contact | undefined> {
    return this.getContact(phoneNumber);
  }

  async updateContactByTenant(_tenant: TenantFilter, phoneNumber: string, updates: Partial<Contact>): Promise<Contact | undefined> {
    return this.updateContact(phoneNumber, updates);
  }

  async getConversationHistoryByTenant(_tenant: TenantFilter, phoneNumber: string, limit: number = 10): Promise<Message[]> {
    return this.getConversationHistory(phoneNumber, limit);
  }

  // HR Admin methods (MemStorage stub implementations)
  private hrAdmins: Map<string, HRAdmin> = new Map();
  private hrChatbotConfig: HRChatbotConfig | undefined;

  // Helper to normalize phone for lookup (handles LID + regular)
  private normalizeHRPhone(phone: string): string {
    if (phone.includes('@')) {
      return phone.split('@')[0].replace(/\D/g, '');
    }
    return phone.replace(/\D/g, '');
  }

  async getHRAdmin(phoneNumber: string): Promise<HRAdmin | undefined> {
    // Try exact match first
    if (this.hrAdmins.has(phoneNumber)) {
      return this.hrAdmins.get(phoneNumber);
    }
    
    // Try fuzzy match
    const cleaned = this.normalizeHRPhone(phoneNumber);
    for (const [key, admin] of this.hrAdmins) {
      const storedCleaned = this.normalizeHRPhone(key);
      if (storedCleaned === cleaned || 
          storedCleaned.slice(-10) === cleaned.slice(-10)) {
        return admin;
      }
    }
    return undefined;
  }

  async getHRAdmins(filters?: { limit?: number; offset?: number }): Promise<HRAdmin[]> {
    const admins = Array.from(this.hrAdmins.values());
    const offset = filters?.offset || 0;
    const limit = filters?.limit || admins.length;
    return admins.slice(offset, offset + limit);
  }

  async getAllHRAdmins(): Promise<HRAdmin[]> {
    return Array.from(this.hrAdmins.values());
  }

  async getHRAdminsByOrganization(organizationId: string): Promise<HRAdmin[]> {
    return Array.from(this.hrAdmins.values()).filter(admin => admin.organizationId === organizationId);
  }

  async createHRAdmin(data: { phoneNumber: string; name?: string; organizationId: string; userId: string; organizationName?: string }): Promise<HRAdmin> {
    // Store phone preserving LID format
    let phoneToStore = data.phoneNumber.replace(/[\s\-\(\)]/g, '');
    if (!phoneToStore.includes('@')) {
      if (phoneToStore.length >= 15) {
        phoneToStore = `${phoneToStore}@lid`;
      }
    }
    
    const admin: HRAdmin = {
      id: randomUUID(),
      phoneNumber: phoneToStore,
      name: data.name || null,
      organizationId: data.organizationId,
      userId: data.userId,
      organizationName: data.organizationName || null,
      chatbotActive: 'true',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.hrAdmins.set(phoneToStore, admin);
    return admin;
  }

  async updateHRAdmin(phoneNumber: string, updates: Partial<HRAdmin>): Promise<HRAdmin | undefined> {
    const existing = await this.getHRAdmin(phoneNumber);
    if (!existing) return undefined;
    const updated = { ...existing, ...updates, updatedAt: new Date() };
    this.hrAdmins.set(existing.phoneNumber, updated);
    return updated;
  }

  async deleteHRAdmin(phoneNumber: string): Promise<void> {
    const existing = await this.getHRAdmin(phoneNumber);
    if (existing) {
      this.hrAdmins.delete(existing.phoneNumber);
    }
  }

  async isHRAdmin(phoneNumber: string): Promise<boolean> {
    const admin = await this.getHRAdmin(phoneNumber);
    return !!admin;
  }

  async getHRChatbotConfig(): Promise<HRChatbotConfig | undefined> {
    return this.hrChatbotConfig;
  }

  async updateHRChatbotConfig(config: Partial<HRChatbotConfig> & { agentName: string }): Promise<HRChatbotConfig> {
    if (this.hrChatbotConfig) {
      this.hrChatbotConfig = {
        ...this.hrChatbotConfig,
        ...config,
        isActive: config.isActive !== undefined ? String(config.isActive) : this.hrChatbotConfig.isActive,
        updatedAt: new Date(),
      };
    } else {
      const id = randomUUID();
      this.hrChatbotConfig = {
        id,
        agentName: config.agentName,
        ragBaseUrl: config.ragBaseUrl || '',
        ragAccessKey: config.ragAccessKey || '',
        supabaseUrl: config.supabaseUrl || '',
        supabaseServiceKey: config.supabaseServiceKey || '',
        contextMessageCount: config.contextMessageCount || 5,
        isActive: config.isActive !== undefined ? String(config.isActive) : 'true',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }
    return this.hrChatbotConfig;
  }
}

// Use database storage when DATABASE_URL is available
import { DatabaseStorage } from './storage/DatabaseStorage';

export const storage = process.env.DATABASE_URL 
  ? new DatabaseStorage()
  : new MemStorage();
