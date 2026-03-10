import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  FileText,
  Plus,
  Loader2,
  Copy,
  Trash2,
  Eye,
} from "lucide-react";

interface Campaign {
  id: string;
  name: string;
  originalMessage: string;
  campaignType: string;
  buttons?: any;
  includeStopButton?: boolean;
  createdAt: string;
}

export function CampaignTemplatesPanel() {
  const [showCreate, setShowCreate] = useState(false);
  const [viewTemplate, setViewTemplate] = useState<Campaign | null>(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: templates = [], isLoading } = useQuery<Campaign[]>({
    queryKey: ["/api/campaign-templates"],
    select: (data: any) => data?.data || data || [],
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/campaigns", {
        name,
        originalMessage: message,
        campaignType: "template",
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Template Created" });
      setShowCreate(false);
      setName("");
      setMessage("");
      queryClient.invalidateQueries({ queryKey: ["/api/campaign-templates"] });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const useTemplateMutation = useMutation({
    mutationFn: async (template: Campaign) => {
      const res = await apiRequest("POST", "/api/campaigns", {
        name: `${template.name} - ${new Date().toLocaleDateString()}`,
        originalMessage: template.originalMessage,
        campaignType: "campaign",
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Campaign Created", description: "Campaign created from template. Go to Campaigns to manage it." });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-6 animate-fade-in-up">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" />
            Message Templates
          </CardTitle>
          <Button onClick={() => setShowCreate(true)} size="sm">
            <Plus className="w-4 h-4 mr-2" /> New Template
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : templates.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No templates yet. Create one to save reusable messages.
            </p>
          ) : (
            <div className="space-y-3">
              {templates.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between p-4 rounded-lg border bg-card/50 hover:bg-accent/30 transition-colors"
                >
                  <div className="flex-1 min-w-0 mr-4">
                    <p className="font-medium text-sm truncate">{t.name}</p>
                    <p className="text-xs text-muted-foreground truncate mt-1">
                      {t.originalMessage.slice(0, 80)}...
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Created {new Date(t.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setViewTemplate(t)}
                      title="Preview"
                    >
                      <Eye className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => useTemplateMutation.mutate(t)}
                      disabled={useTemplateMutation.isPending}
                      title="Create campaign from template"
                    >
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Template Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Message Template</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Template Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Welcome Message" />
            </div>
            <div>
              <Label>Message Content</Label>
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Type your template message..."
                rows={6}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Use {"{{name}}"}, {"{{phone}}"} as placeholders for personalization.
              </p>
            </div>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!name.trim() || !message.trim() || createMutation.isPending}
              className="w-full"
            >
              {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              Save Template
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* View Template Dialog */}
      <Dialog open={!!viewTemplate} onOpenChange={() => setViewTemplate(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{viewTemplate?.name}</DialogTitle>
          </DialogHeader>
          <div className="bg-accent/30 p-4 rounded-lg whitespace-pre-wrap text-sm">
            {viewTemplate?.originalMessage}
          </div>
          <Button onClick={() => { if (viewTemplate) useTemplateMutation.mutate(viewTemplate); setViewTemplate(null); }}>
            <Copy className="w-4 h-4 mr-2" /> Use as Campaign
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
