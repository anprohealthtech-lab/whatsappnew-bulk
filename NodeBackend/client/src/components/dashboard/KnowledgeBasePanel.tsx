import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import {
  Upload,
  FileText,
  Trash2,
  Loader2,
  CheckCircle,
  AlertCircle,
  Clock,
  Database,
  Send,
  RotateCw,
} from "lucide-react";

interface KnowledgeFile {
  id: string;
  file_name: string;
  file_size: number;
  chunk_count: number;
  status: string;
  error_message?: string;
  created_at: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "ready":
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
          <CheckCircle className="w-3 h-3" /> Ready
        </span>
      );
    case "processing":
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
          <Clock className="w-3 h-3 animate-spin" /> Processing
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
          <AlertCircle className="w-3 h-3" /> Failed
        </span>
      );
    default:
      return <span className="text-xs text-muted-foreground">{status}</span>;
  }
}

export function KnowledgeBasePanel() {
  const [testMessage, setTestMessage] = useState("");
  const [testResponse, setTestResponse] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: files = [], isLoading } = useQuery<KnowledgeFile[]>({
    queryKey: ["/api/knowledge/files"],
    select: (data: any) => data?.data || [],
    refetchInterval: 5000, // Poll to catch processing→ready transitions
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/knowledge/upload", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("auth_token") || ""}`,
        },
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Upload failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "File uploaded", description: "Processing will complete shortly." });
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/files"] });
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    onError: (err: any) =>
      toast({ title: "Upload failed", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (fileId: string) => {
      const res = await apiRequest("DELETE", `/api/knowledge/files/${fileId}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "File deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/files"] });
    },
    onError: (err: any) =>
      toast({ title: "Delete failed", description: err.message, variant: "destructive" }),
  });

  const retryMutation = useMutation({
    mutationFn: async (fileId: string) => {
      const res = await apiRequest("POST", `/api/knowledge/files/${fileId}/retry`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Retry started", description: "File is being reprocessed." });
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/files"] });
    },
    onError: (err: any) =>
      toast({ title: "Retry failed", description: err.message, variant: "destructive" }),
  });

  const testChatMutation = useMutation({
    mutationFn: async (message: string) => {
      const res = await apiRequest("POST", "/api/knowledge/chat", { message });
      return res.json();
    },
    onSuccess: (data) => {
      const content = data?.data?.choices?.[0]?.message?.content;
      setTestResponse(content || "No response received");
    },
    onError: (err: any) => {
      setTestResponse(`Error: ${err.message}`);
    },
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadMutation.mutate(file);
  };

  const readyCount = files.filter((f) => f.status === "ready").length;
  const totalChunks = files.filter((f) => f.status === "ready").reduce((sum, f) => sum + (f.chunk_count || 0), 0);

  return (
    <div className="space-y-6 animate-fade-in-up">
      {/* Upload Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="w-5 h-5 text-primary" />
            Knowledge Base
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Upload your business documents (PDF, TXT, CSV, MD, DOCX). The chatbot will search these files to answer WhatsApp messages with your specific information.
          </p>

          {/* Stats */}
          <div className="flex gap-4 text-sm">
            <div className="flex items-center gap-1">
              <FileText className="w-4 h-4 text-muted-foreground" />
              <span>{readyCount} file{readyCount !== 1 ? "s" : ""} ready</span>
            </div>
            <div className="flex items-center gap-1">
              <Database className="w-4 h-4 text-muted-foreground" />
              <span>{totalChunks} knowledge chunks</span>
            </div>
          </div>

          {/* Upload Button */}
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.csv,.md,.pdf,.docx"
              className="hidden"
              onChange={handleFileSelect}
            />
            <Button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadMutation.isPending}
            >
              {uploadMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Upload className="w-4 h-4 mr-2" />
              )}
              Upload File
            </Button>
            <span className="text-xs text-muted-foreground ml-2">Max 10MB</span>
          </div>

          {/* File List */}
          {isLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : files.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground text-sm">
              No files uploaded yet. Upload documents to build your chatbot's knowledge base.
            </div>
          ) : (
            <div className="border rounded-lg divide-y">
              {files.map((file) => (
                <div key={file.id} className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{file.file_name}</p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{formatBytes(file.file_size)}</span>
                        {file.status === "ready" && (
                          <span>{file.chunk_count} chunks</span>
                        )}
                        {file.error_message && (
                          <span className="text-red-500" title={file.error_message}>
                            {file.error_message.substring(0, 50)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <StatusBadge status={file.status} />
                    {file.status === "failed" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => retryMutation.mutate(file.id)}
                        disabled={retryMutation.isPending}
                        title="Retry processing"
                      >
                        <RotateCw className="w-4 h-4 text-blue-500" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteMutation.mutate(file.id)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Test Chat Card */}
      {readyCount > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Test Knowledge Base</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Ask a question to test if the chatbot can find answers from your uploaded files.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                className="flex-1 px-3 py-2 border rounded-md text-sm"
                placeholder="Ask a question about your business..."
                value={testMessage}
                onChange={(e) => setTestMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && testMessage.trim()) {
                    testChatMutation.mutate(testMessage);
                  }
                }}
              />
              <Button
                onClick={() => testChatMutation.mutate(testMessage)}
                disabled={!testMessage.trim() || testChatMutation.isPending}
                size="sm"
              >
                {testChatMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </Button>
            </div>
            {testResponse && (
              <div className="p-3 bg-muted rounded-md text-sm whitespace-pre-wrap">
                {testResponse}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
