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
  Database,
  MessageSquare,
  Clock,
  Hash,
  X,
} from "lucide-react";

interface RagConfig {
  id?: string;
  agentName: string;
  ragBaseUrl: string;
  ragAccessKey: string;
  systemPrompt?: string;
  isActive: string;
  triggerKeywords?: string[];
  greetingMessage?: string;
  contextMessageCount?: number;
  replyCooldownSeconds?: number;
  typingDelayMs?: number;
}

export function UserRagSettingsPanel() {
  const [agentName, setAgentName] = useState("");
  const [ragBaseUrl, setRagBaseUrl] = useState("");
  const [ragAccessKey, setRagAccessKey] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [useBuiltInRag, setUseBuiltInRag] = useState(false);
  const [triggerKeywords, setTriggerKeywords] = useState<string[]>([]);
  const [keywordInput, setKeywordInput] = useState("");
  const [greetingMessage, setGreetingMessage] = useState("");
  const [contextMessageCount, setContextMessageCount] = useState<number | "">(5);
  const [replyCooldownSeconds, setReplyCooldownSeconds] = useState<number | "">(10);
  const [typingDelayMs, setTypingDelayMs] = useState<number | "">(2000);
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
      const isBuiltIn = config.ragBaseUrl === "supabase-knowledge-base";
      setUseBuiltInRag(isBuiltIn);
      setRagBaseUrl(isBuiltIn ? "" : (config.ragBaseUrl || ""));
      if (!ragAccessKey) setRagAccessKey("");
      setSystemPrompt(config.systemPrompt || "");
      setIsActive(config.isActive !== "false");
      setTriggerKeywords(config.triggerKeywords || []);
      setGreetingMessage(config.greetingMessage || "");
      setContextMessageCount(config.contextMessageCount ?? 5);
      setReplyCooldownSeconds(config.replyCooldownSeconds ?? 10);
      setTypingDelayMs(config.typingDelayMs ?? 2000);
    }
  }, [config]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: any = {
        agentName: agentName || "Knowledge Base Bot",
        ragBaseUrl: useBuiltInRag ? "supabase-knowledge-base" : ragBaseUrl,
        isActive,
      };
      // For built-in RAG, set a placeholder key
      if (useBuiltInRag) {
        body.ragAccessKey = "built-in";
      } else if (ragAccessKey && !ragAccessKey.includes("****")) {
        body.ragAccessKey = ragAccessKey;
      } else if (config?.ragAccessKey) {
        body.ragAccessKey = "KEEP_EXISTING";
      } else {
        body.ragAccessKey = ragAccessKey;
      }
      if (systemPrompt) body.systemPrompt = systemPrompt;
      if (triggerKeywords.length > 0) body.triggerKeywords = triggerKeywords;
      if (greetingMessage) body.greetingMessage = greetingMessage;
      if (contextMessageCount !== "") body.contextMessageCount = contextMessageCount;
      if (replyCooldownSeconds !== "") body.replyCooldownSeconds = replyCooldownSeconds;
      if (typingDelayMs !== "") body.typingDelayMs = typingDelayMs;

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

          {/* Toggle between built-in and external RAG */}
          <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/50">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-primary" />
              <div>
                <Label className="cursor-pointer">Use Built-in Knowledge Base</Label>
                <p className="text-xs text-muted-foreground">
                  Uses your uploaded files (Knowledge Base tab) instead of an external AI agent.
                </p>
              </div>
            </div>
            <Switch checked={useBuiltInRag} onCheckedChange={setUseBuiltInRag} />
          </div>

          {!useBuiltInRag && (
            <>
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
            </>
          )}

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

          {/* Lead Chatbot Behaviour Section */}
          <div className="border-t pt-4 mt-4">
            <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
              <MessageSquare className="w-4 h-4 text-primary" />
              Lead Chatbot Behaviour
            </h3>

            {/* Trigger Keywords */}
            <div className="mb-3">
              <Label>Trigger Keywords</Label>
              <p className="text-xs text-muted-foreground mb-1">
                Words that mark a contact as a lead. Leave empty to use global keywords.
              </p>
              <div className="flex flex-wrap gap-1 mb-1">
                {triggerKeywords.map((kw, i) => (
                  <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs">
                    {kw}
                    <X className="w-3 h-3 cursor-pointer" onClick={() => setTriggerKeywords(triggerKeywords.filter((_, j) => j !== i))} />
                  </span>
                ))}
              </div>
              <div className="flex gap-1">
                <Input
                  value={keywordInput}
                  onChange={(e) => setKeywordInput(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" || e.key === ",") && keywordInput.trim()) {
                      e.preventDefault();
                      setTriggerKeywords([...triggerKeywords, keywordInput.trim()]);
                      setKeywordInput("");
                    }
                  }}
                  placeholder="Type keyword, press Enter"
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!keywordInput.trim()}
                  onClick={() => {
                    setTriggerKeywords([...triggerKeywords, keywordInput.trim()]);
                    setKeywordInput("");
                  }}
                >
                  Add
                </Button>
              </div>
            </div>

            {/* Greeting Message */}
            <div className="mb-3">
              <Label>Greeting Message</Label>
              <Textarea
                value={greetingMessage}
                onChange={(e) => setGreetingMessage(e.target.value)}
                placeholder="e.g., Hi! Thanks for reaching out. How can I help you today?"
                rows={3}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Sent when a new lead is first detected. Leave empty for global greeting.
              </p>
            </div>

            {/* Numeric Config Row */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label className="flex items-center gap-1">
                  <Hash className="w-3 h-3" /> Context Messages
                </Label>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={contextMessageCount}
                  onChange={(e) => setContextMessageCount(e.target.value ? Number(e.target.value) : "")}
                />
                <p className="text-xs text-muted-foreground mt-0.5">History sent to RAG</p>
              </div>
              <div>
                <Label className="flex items-center gap-1">
                  <Clock className="w-3 h-3" /> Cooldown (s)
                </Label>
                <Input
                  type="number"
                  min={0}
                  max={600}
                  value={replyCooldownSeconds}
                  onChange={(e) => setReplyCooldownSeconds(e.target.value ? Number(e.target.value) : "")}
                />
                <p className="text-xs text-muted-foreground mt-0.5">Min seconds between replies</p>
              </div>
              <div>
                <Label className="flex items-center gap-1">
                  <Clock className="w-3 h-3" /> Typing Delay (ms)
                </Label>
                <Input
                  type="number"
                  min={0}
                  max={10000}
                  step={500}
                  value={typingDelayMs}
                  onChange={(e) => setTypingDelayMs(e.target.value ? Number(e.target.value) : "")}
                />
                <p className="text-xs text-muted-foreground mt-0.5">Simulated typing time</p>
              </div>
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={!agentName.trim() || (!useBuiltInRag && !ragBaseUrl.trim()) || saveMutation.isPending}
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
