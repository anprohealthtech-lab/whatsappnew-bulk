import { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLocation } from "wouter";
import { api } from "@/lib/api";
import { useSocket } from "@/hooks/useSocket";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Wifi,
  WifiOff,
  Bell,
  RefreshCw,
  QrCode
} from "lucide-react";

import { Sidebar } from "@/components/dashboard/Sidebar";
import { StatusCards } from "@/components/dashboard/StatusCards";
import { MessageForm } from "@/components/dashboard/MessageForm";
import { ReportForm } from "@/components/dashboard/ReportForm";
import { MessageHistory } from "@/components/dashboard/MessageHistory";
import { AutoResponsePanel } from "@/components/dashboard/AutoResponsePanel";
import { LeadsPanel } from "@/components/dashboard/LeadsPanel";

// Form schemas
const messageSchema = z.object({
  phoneNumber: z.string().min(1, "Phone number is required"),
  content: z.string().min(1, "Message content is required"),
});

const reportSchema = z.object({
  phoneNumber: z.string().min(1, "Phone number is required"),
  sampleId: z.string().min(1, "Sample ID is required"),
  content: z.string().optional(),
  file: z.instanceof(File).refine((file) => file.size > 0, "File is required"),
});

type MessageFormData = z.infer<typeof messageSchema>;
type ReportFormData = z.infer<typeof reportSchema>;

export default function Dashboard() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [showQRModal, setShowQRModal] = useState(false);
  const [messageFilters, setMessageFilters] = useState({
    status: "all",
    search: "",
    limit: 10,
    offset: 0,
  });
  const [activeSection, setActiveSection] = useState<string>("dashboard");
  const [showIncomingPanel, setShowIncomingPanel] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isConnected, whatsappStatus, qrCode } = useSocket();
  const [, setLocation] = useLocation();

  // Auto-show QR modal when WhatsApp is not connected 
  useEffect(() => {
    if (!whatsappStatus.isConnected && !whatsappStatus.isAuthenticated) {
      setShowQRModal(true);
      console.log('🎯 WhatsApp not connected - showing QR modal to initiate connection');
    }
  }, [whatsappStatus.isConnected, whatsappStatus.isAuthenticated]);

  // Auto-hide QR modal when WhatsApp connects
  useEffect(() => {
    if (whatsappStatus.isConnected) {
      setShowQRModal(false);
      console.log('🎯 WhatsApp connected, hiding QR modal');
    }
  }, [whatsappStatus.isConnected]);

  // Form setup
  const messageForm = useForm<MessageFormData>({
    resolver: zodResolver(messageSchema),
    defaultValues: {
      phoneNumber: "",
      content: "",
    },
  });

  const reportForm = useForm<ReportFormData>({
    resolver: zodResolver(reportSchema),
    defaultValues: {
      phoneNumber: "",
      sampleId: "",
      content: "",
    },
  });

  // Queries
  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ["/api/status"],
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  const { data: messageHistory, isLoading: messagesLoading } = useQuery({
    queryKey: ["/api/messages", messageFilters],
    queryFn: () => api.getMessages(messageFilters),
  });

  const { data: incomingMessages = [] } = useQuery({
    queryKey: ["/api/incoming-messages"],
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  const { data: autoResponses = [] } = useQuery<any[]>({
    queryKey: ["/api/auto-responses/all"],
    refetchInterval: 30000,
  });

  // Mutations
  const sendMessageMutation = useMutation({
    mutationFn: ({ phoneNumber, content }: MessageFormData) =>
      api.sendMessage(phoneNumber, content),
    onSuccess: () => {
      messageForm.reset();
      queryClient.invalidateQueries({ queryKey: ["/api/messages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      toast({
        title: "Message Sent",
        description: "Your message has been sent successfully",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to send message",
        variant: "destructive",
      });
    },
  });

  const sendReportMutation = useMutation({
    mutationFn: ({ phoneNumber, sampleId, content, file }: ReportFormData) =>
      api.sendReport(phoneNumber, sampleId, file, content),
    onSuccess: () => {
      reportForm.reset();
      setSelectedFile(null);
      queryClient.invalidateQueries({ queryKey: ["/api/messages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      toast({
        title: "Report Sent",
        description: "Your report has been sent successfully",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to send report",
        variant: "destructive",
      });
    },
  });

  const generateQRMutation = useMutation({
    mutationFn: api.generateQR,
    onSuccess: () => {
      setShowQRModal(true);
      toast({
        title: "QR Code Generated",
        description: "Scan the QR code with WhatsApp to connect",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to generate QR code",
        variant: "destructive",
      });
    },
  });

  const resendMessageMutation = useMutation({
    mutationFn: (messageId: string) => api.resendMessage(messageId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/messages"] });
      toast({
        title: "Message Resent",
        description: "The message has been resent successfully",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to resend message",
        variant: "destructive",
      });
    },
  });

  const createAutoResponseMutation = useMutation({
    mutationFn: (data: { keyword: string; response: string; isActive?: boolean }) =>
      api.post("/api/auto-responses", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auto-responses/all"] });
      toast({
        title: "Auto-Response Created",
        description: "New auto-response has been added successfully",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to create auto-response",
        variant: "destructive",
      });
    },
  });

  const updateAutoResponseMutation = useMutation({
    mutationFn: ({ id, ...data }: { id: string; keyword?: string; response?: string; isActive?: boolean }) =>
      api.put(`/api/auto-responses/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auto-responses/all"] });
      toast({
        title: "Auto-Response Updated",
        description: "Auto-response has been updated successfully",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to update auto-response",
        variant: "destructive",
      });
    },
  });

  const deleteAutoResponseMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/auto-responses/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auto-responses/all"] });
      toast({
        title: "Auto-Response Deleted",
        description: "Auto-response has been deleted successfully",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to delete auto-response",
        variant: "destructive",
      });
    },
  });

  // Handlers
  const handleSendMessage = (data: MessageFormData) => {
    sendMessageMutation.mutate(data);
  };

  const handleSendReport = (data: ReportFormData) => {
    if (!selectedFile) {
      toast({
        title: "Error",
        description: "Please select a file to upload",
        variant: "destructive",
      });
      return;
    }

    sendReportMutation.mutate({
      ...data,
      file: selectedFile,
    });
  };

  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      // Validate file type and size
      const allowedTypes = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
      const maxSize = 10 * 1024 * 1024; // 10MB

      if (!allowedTypes.includes(file.type)) {
        toast({
          title: "Invalid File Type",
          description: "Please select a PDF, JPG, or PNG file",
          variant: "destructive",
        });
        return;
      }

      if (file.size > maxSize) {
        toast({
          title: "File Too Large",
          description: "File size must be less than 10MB",
          variant: "destructive",
        });
        return;
      }

      setSelectedFile(file);
      reportForm.setValue("file", file);
    }
  }, [reportForm, toast]);

  const handleFileDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) {
      const input = document.createElement('input');
      input.type = 'file';
      input.files = event.dataTransfer.files;
      const fakeEvent = { target: input } as React.ChangeEvent<HTMLInputElement>;
      handleFileSelect(fakeEvent);
    }
  }, [handleFileSelect]);

  const handleFilterChange = (key: string, value: string) => {
    setMessageFilters(prev => ({
      ...prev,
      [key]: value,
      offset: 0, // Reset to first page when filtering
    }));
  };

  const formatTimestamp = (timestamp: string) => {
    return new Date(timestamp).toLocaleString();
  };

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Sidebar */}
      <Sidebar
        activeSection={activeSection}
        setActiveSection={setActiveSection}
        setLocation={setLocation}
      />

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden relative">
        {/* Header */}
        <header className="bg-white/80 dark:bg-zinc-900/80 backdrop-blur-md border-b border-gray-200 dark:border-zinc-800 px-8 py-5 flex items-center justify-between z-10">
          <div>
            <h2 className="text-2xl font-bold text-foreground tracking-tight">Dashboard</h2>
            <p className="text-muted-foreground text-sm">Overview & Quick Actions</p>
          </div>
          <div className="flex items-center space-x-4">
            <div className="flex items-center px-3 py-1.5 rounded-full bg-gray-100 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700">
              {isConnected ? (
                <Wifi className="w-4 h-4 text-green-500 mr-2" />
              ) : (
                <WifiOff className="w-4 h-4 text-red-500 mr-2" />
              )}
              <span className="text-sm font-medium text-foreground">
                {isConnected ? 'Connected' : 'Disconnected'}
              </span>
            </div>

            <Button
              variant="outline"
              size="icon"
              onClick={() => setShowIncomingPanel(true)}
              className="relative rounded-full w-10 h-10 border-gray-200 dark:border-zinc-700"
            >
              <Bell className="w-5 h-5 text-muted-foreground" />
              {unreadCount > 0 && (
                <span className="absolute top-0 right-0 bg-red-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center ring-2 ring-white dark:ring-zinc-900">
                  {unreadCount}
                </span>
              )}
            </Button>

            <Button
              variant="outline"
              size="icon"
              onClick={() => queryClient.invalidateQueries()}
              disabled={statusLoading}
              className="rounded-full w-10 h-10 border-gray-200 dark:border-zinc-700"
            >
              <RefreshCw className={`w-5 h-5 text-muted-foreground ${statusLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-8 space-y-8 scrollbar-hide">
          {/* Status Cards - Always visible */}
          <StatusCards
            whatsappStatus={whatsappStatus}
            status={status}
            generateQRMutation={generateQRMutation}
            formatTimestamp={formatTimestamp}
          />

          {/* Dashboard View */}
          {activeSection === "dashboard" && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              {/* Send Message Panel */}
              <div className="lg:col-span-1 space-y-8">
                <MessageForm
                  form={messageForm}
                  onSubmit={handleSendMessage}
                  isLoading={sendMessageMutation.isPending}
                />

                <ReportForm
                  form={reportForm}
                  onSubmit={handleSendReport}
                  isLoading={sendReportMutation.isPending}
                  selectedFile={selectedFile}
                  onFileSelect={handleFileSelect}
                  onFileDrop={handleFileDrop}
                />
              </div>

              {/* Message History */}
              <div className="lg:col-span-2">
                <MessageHistory
                  messages={messageHistory?.messages || []}
                  isLoading={messagesLoading}
                  filters={messageFilters}
                  onFilterChange={handleFilterChange}
                  onResend={(id) => resendMessageMutation.mutate(id)}
                  formatTimestamp={formatTimestamp}
                />
              </div>
            </div>
          )}

          {/* History Section */}
          {activeSection === "history" && (
            <MessageHistory
              messages={messageHistory?.messages || []}
              isLoading={messagesLoading}
              filters={messageFilters}
              onFilterChange={handleFilterChange}
              onResend={(id) => resendMessageMutation.mutate(id)}
              formatTimestamp={formatTimestamp}
            />
          )}

          {/* Auto-Responses Section */}
          {activeSection === "auto-responses" && (
            <AutoResponsePanel
              autoResponses={autoResponses}
              onCreate={(data) => createAutoResponseMutation.mutate(data)}
              onUpdate={(data) => updateAutoResponseMutation.mutate(data)}
              onDelete={(id) => deleteAutoResponseMutation.mutate(id)}
            />
          )}

          {/* Leads Section */}
          {activeSection === "leads" && <LeadsPanel />}
        </main>
      </div>

      {/* QR Code Modal */}
      <Dialog open={showQRModal} onOpenChange={setShowQRModal}>
        <DialogContent className="max-w-md border-none shadow-2xl bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl">
          <DialogHeader>
            <DialogTitle className="text-center text-xl font-bold">Connect WhatsApp</DialogTitle>
          </DialogHeader>

          <div className="text-center">
            <div className="w-64 h-64 bg-white rounded-2xl mx-auto mb-6 flex items-center justify-center shadow-inner border border-gray-100 p-2">
              {qrCode ? (
                <div className="text-center w-full h-full">
                  <img
                    src={qrCode}
                    alt="WhatsApp QR Code"
                    className="w-full h-full object-contain rounded-xl"
                    onError={(e) => {
                      console.error('QR Code image failed to load:', qrCode);
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                </div>
              ) : (
                <div className="text-center">
                  <QrCode className="w-16 h-16 text-gray-300 mx-auto mb-3" />
                  <p className="text-sm text-gray-500 font-medium">Generating QR code...</p>
                </div>
              )}
            </div>

            <div className="space-y-3 text-sm text-muted-foreground mb-8 text-left bg-gray-50 dark:bg-zinc-800/50 p-4 rounded-xl">
              <p className="font-semibold text-foreground flex items-center">
                <Wifi className="w-4 h-4 mr-2 text-primary" />
                To connect your WhatsApp:
              </p>
              <ol className="list-decimal list-inside space-y-1 ml-1">
                <li>Open <strong>WhatsApp</strong> on your phone</li>
                <li>Go to <strong>Settings</strong> → <strong>Linked Devices</strong></li>
                <li>Tap <strong>"Link a Device"</strong></li>
                <li>Scan the QR code above</li>
              </ol>
            </div>

            <div className="flex space-x-3">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => generateQRMutation.mutate()}
                disabled={generateQRMutation.isPending}
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                Refresh QR
              </Button>
              <Button
                className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground"
                onClick={() => setShowQRModal(false)}
              >
                Done
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
