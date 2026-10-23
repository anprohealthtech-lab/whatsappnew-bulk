import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { Cloud, Loader2, CheckCircle2, Unplug, ShieldCheck } from "lucide-react";
import { parseMetaSignupMessage } from "@shared/metaSignup";

/**
 * "Connect WhatsApp Business (official API)" card.
 *
 * Opens Meta's Embedded Signup popup. The popup posts a WA_EMBEDDED_SIGNUP
 * message with the new phone_number_id / waba_id, and FB.login() returns a
 * one-time code. Both go to POST /api/cloud/onboard which exchanges the code
 * for a permanent token and creates the tenant's cloud_api session.
 */

declare global {
  interface Window {
    FB?: any;
    fbAsyncInit?: () => void;
  }
}

interface SignupConfig {
  enabled: boolean;
  appId: string;
  configId: string;
  graphVersion: string;
}

interface CloudSessionInfo {
  sessionName: string;
  phoneNumber: string | null;
  cloudPhoneNumberId: string | null;
  cloudWabaId: string | null;
  status: string;
  connected: boolean;
  verifiedName: string | null;
  qualityRating: string | null;
  lastConnectedAt: string | null;
}

type SignupResult = { phoneNumberId?: string; wabaId?: string; event?: string; errorMessage?: string };

function loadFacebookSdk(appId: string, version: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.FB) {
      resolve();
      return;
    }
    window.fbAsyncInit = () => {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve();
    };
    const existing = document.getElementById("facebook-jssdk");
    if (existing) return;
    const script = document.createElement("script");
    script.id = "facebook-jssdk";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.onerror = () => reject(new Error("Could not load Meta's SDK. Check ad blockers or network."));
    document.body.appendChild(script);
  });
}

export function CloudApiConnectPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const signupResult = useRef<SignupResult>({});

  const { data: config } = useQuery<SignupConfig>({
    queryKey: ["/api/cloud/signup-config"],
    queryFn: async () => (await apiRequest("GET", "/api/cloud/signup-config")).json(),
  });

  const { data: sessionData, isLoading } = useQuery<{ session: CloudSessionInfo | null }>({
    queryKey: ["/api/cloud/session"],
    queryFn: async () => (await apiRequest("GET", "/api/cloud/session")).json(),
    refetchInterval: 30000,
  });
  const session = sessionData?.session ?? null;

  // Meta's popup reports the created assets through window.postMessage.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const payload = parseMetaSignupMessage(event.origin, event.data);
      if (!payload) return;
      if (payload.event === "FINISH" || payload.event === "FINISH_ONLY_WABA" || payload.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING") {
        signupResult.current = {
          event: payload.event,
          phoneNumberId: payload.data?.phone_number_id || signupResult.current.phoneNumberId,
          wabaId: payload.data?.waba_id || signupResult.current.wabaId,
        };
        setProgress("Signup finished, linking the number...");
      } else if (payload.event === "CANCEL") {
        signupResult.current = { event: "CANCEL" };
        setProgress(null);
      } else if (payload.event === "ERROR") {
        signupResult.current = { event: "ERROR", errorMessage: payload.data?.error_message };
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const onboard = useMutation({
    mutationFn: async (body: { code: string; phoneNumberId?: string; wabaId: string }) => {
      const res = await apiRequest("POST", "/api/cloud/onboard", body);
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({ title: "WhatsApp connected", description: `${data?.phone?.number || "Number"} is now linked through the official API.` });
      queryClient.invalidateQueries({ queryKey: ["/api/cloud/session"] });
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/sessions"] });
    },
    onError: (error: Error) => {
      toast({ title: "Could not link the number", description: error.message, variant: "destructive" });
    },
    onSettled: () => {
      setBusy(false);
      setProgress(null);
    },
  });

  const disconnect = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/cloud/session/disconnect")).json(),
    onSuccess: () => {
      toast({ title: "Disconnected", description: "The official API session was unloaded. Reconnect any time." });
      queryClient.invalidateQueries({ queryKey: ["/api/cloud/session"] });
    },
    onError: (error: Error) => toast({ title: "Disconnect failed", description: error.message, variant: "destructive" }),
  });

  const startSignup = async () => {
    if (!config?.enabled) return;
    setBusy(true);
    setProgress("Opening Meta's signup window...");
    signupResult.current = {};
    try {
      await loadFacebookSdk(config.appId, config.graphVersion);
    } catch (error) {
      setBusy(false);
      setProgress(null);
      toast({ title: "Meta SDK not available", description: (error as Error).message, variant: "destructive" });
      return;
    }

    window.FB.login(
      (response: any) => {
        const code: string | undefined = response?.authResponse?.code;
        if (!code) {
          setBusy(false);
          setProgress(null);
          if (signupResult.current.event !== "CANCEL") {
            toast({ title: "Signup not completed", description: signupResult.current.errorMessage || "The Meta window was closed before finishing.", variant: "destructive" });
          }
          return;
        }
        // The FINISH message usually lands before this callback; give it a moment if not.
        const finish = (attempt: number) => {
          if (signupResult.current.event === "CANCEL" || signupResult.current.event === "ERROR") {
            setBusy(false);
            setProgress(null);
            if (signupResult.current.event === "ERROR") {
              toast({ title: "Meta signup failed", description: signupResult.current.errorMessage || "Meta reported an error completing signup.", variant: "destructive" });
            }
            return;
          }
          const { phoneNumberId, wabaId } = signupResult.current;
          if (phoneNumberId && wabaId) {
            onboard.mutate({ code, phoneNumberId, wabaId });
          } else if (attempt < 60) {
            setTimeout(() => finish(attempt + 1), 250);
          } else if (wabaId) {
            // Some completed flows return the account without a phone ID.
            // The server may resolve it only when that account has one phone.
            onboard.mutate({ code, wabaId });
          } else {
            setBusy(false);
            setProgress(null);
            toast({
              title: "Meta signup details were not received",
              description: `Facebook authorized the login, but the WhatsApp account details did not reach this page (event: ${signupResult.current.event || "none"}). Your phone verification may have succeeded. Check the Embedded Signup configuration and popup completion before retrying.`,
              variant: "destructive",
            });
          }
        };
        finish(0);
      },
      {
        config_id: config.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: {
          setup: {},
          featureType: "",
          sessionInfoVersion: "3",
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cloud className="h-5 w-5" />
          WhatsApp Business Platform (official API)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Link a WhatsApp Business number through Meta's official API instead of a QR code. No phone needs to stay
          online, there is no risk of the number being banned for automation, and your team can keep using the
          WhatsApp Business app on the same number.
        </p>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking status...
          </div>
        ) : session ? (
          <div className="rounded-md border p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={session.connected ? "default" : "secondary"}>
                {session.connected ? "Connected" : session.status}
              </Badge>
              <span className="font-medium">{session.phoneNumber ? `+${session.phoneNumber}` : "Number pending"}</span>
              {session.verifiedName && <span className="text-sm text-muted-foreground">({session.verifiedName})</span>}
              {session.qualityRating && (
                <Badge variant="outline" className="gap-1">
                  <ShieldCheck className="h-3 w-3" /> Quality {session.qualityRating}
                </Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              Session "{session.sessionName}" · Account {session.cloudWabaId || "?"} · Number id {session.cloudPhoneNumberId || "?"}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={startSignup} disabled={busy || !config?.enabled}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                Re-link / change number
              </Button>
              {session.connected && (
                <Button variant="ghost" size="sm" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
                  <Unplug className="h-4 w-4 mr-1" /> Disconnect
                </Button>
              )}
            </div>
          </div>
        ) : (
          <>
            {!config?.enabled && (
              <Alert>
                <AlertDescription>
                  Official API linking is not enabled on this server yet (META_APP_ID / META_ES_CONFIG_ID missing).
                </AlertDescription>
              </Alert>
            )}
            <Button onClick={startSignup} disabled={busy || !config?.enabled}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
              Connect WhatsApp Business number
            </Button>
            <ul className="text-xs text-muted-foreground list-disc pl-5 space-y-1">
              <li>You will log in to Facebook and pick or create your Meta Business portfolio.</li>
              <li>Add the number you want to use. A number already on the WhatsApp Business app can stay on the app.</li>
              <li>Messaging charges from Meta are billed to your own business account.</li>
            </ul>
          </>
        )}

        {progress && (
          <div className="flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> {progress}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
