import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  Bot,
  Save,
  Loader2,
  TestTube2,
  CheckCircle,
  AlertCircle,
} from "lucide-react";

interface RagConfig {
  id?: string;
  agentName: string;
  ragBaseUrl: string;
  ragAccessKey: string;
  systemPrompt?: string;
  isActive: string;
}

export function UserRagSettingsPanel() {
  const [agentName, setAgentName] = useState("");
  const [ragBaseUrl, setRagBaseUrl] = useState("");
  const [ragAccessKey, setRagAccessKey] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [isActive, setIsActive] = useState(true);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: config, isLoading } = useQuery<RagConfig | null>({
    queryKey: ["/api/user-rag-agent"],
    select: (data: any) => data?.data || null,
  });

  // Sync form with loaded config
  useEffect(() => {
    if (config) {
      setAgentName(config.agentName || "");
      setRagBaseUrl(config.ragBaseUrl || "");
      // Don't overwrite key field with masked value if user already typed
      if (!ragAccessKey) setRagAccessKey("");
      setSystemPrompt(config.systemPrompt || "");
      setIsActive(config.isActive !== "false");
    }
  }, [config]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: any = {
        agentName,
        ragBaseUrl,
        isActive,
      };
      // Only send key if user changed it (not masked)
      if (ragAccessKey && !ragAccessKey.includes("****")) {
        body.ragAccessKey = ragAccessKey;
      } else if (config?.ragAccessKey) {
        // Keep existing (server will preserve)
        body.ragAccessKey = "KEEP_EXISTING";
      } else {
        body.ragAccessKey = ragAccessKey;
      }
      if (systemPrompt) body.systemPrompt = systemPrompt;

      const res = await apiRequest("POST", "/api/user-rag-agent", body);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "RAG Config Saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/user-rag-agent"] });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/chatbot/test", {});
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        toast({ title: "Connection Successful", description: "RAG endpoint is reachable." });
      } else {
        toast({ title: "Connection Failed", description: data.message || "Could not reach endpoint", variant: "destructive" });
      }
    },
    onError: (err: any) => toast({ title: "Test Failed", description: err.message, variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in-up">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-primary" />
            AI Chatbot / RAG Agent Settings
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label>Active</Label>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>

          <div>
            <Label>Agent Name</Label>
            <Input
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              placeholder="e.g., Sales Bot"
            />
          </div>

          <div>
            <Label>RAG Base URL</Label>
            <Input
              value={ragBaseUrl}
              onChange={(e) => setRagBaseUrl(e.target.value)}
              placeholder="https://your-agent.digitalocean.app"
            />
            <p className="text-xs text-muted-foreground mt-1">
              The base URL of your DigitalOcean AI Agent or compatible endpoint.
            </p>
          </div>

          <div>
            <Label>RAG Access Key</Label>
            <Input
              type="password"
              value={ragAccessKey}
              onChange={(e) => setRagAccessKey(e.target.value)}
              placeholder={config?.ragAccessKey ? "••••••••" : "Enter access key"}
            />
          </div>

          <div>
            <Label>Custom System Prompt (optional)</Label>
            <Textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Override the default system prompt for your chatbot..."
              rows={5}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Leave empty to use the default system prompt.
            </p>
          </div>

          <div className="flex gap-2">
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={!agentName.trim() || !ragBaseUrl.trim() || saveMutation.isPending}
              className="flex-1"
            >
              {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
              Save Settings
            </Button>
            <Button
              variant="outline"
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending}
            >
              {testMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <TestTube2 className="w-4 h-4 mr-2" />}
              Test Connection
            </Button>
          </div>

          {config && (
            <div className="flex items-center gap-2 text-sm">
              {config.isActive !== "false" ? (
                <>
                  <CheckCircle className="w-4 h-4 text-green-500" />
                  <span className="text-muted-foreground">RAG agent is active: <strong>{config.agentName}</strong></span>
                </>
              ) : (
                <>
                  <AlertCircle className="w-4 h-4 text-yellow-500" />
                  <span className="text-muted-foreground">RAG agent is paused</span>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
