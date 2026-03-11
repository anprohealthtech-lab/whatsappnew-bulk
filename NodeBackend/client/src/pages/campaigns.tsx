import { CampaignMessageVariationPanel } from '@/components/CampaignMessageVariationPanel';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Megaphone } from 'lucide-react';
import { useLocation } from 'wouter';

export default function CampaignsPage() {
  const [, setLocation] = useLocation();

  // These should come from environment variables or configuration
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
  const edgeFunctionUrl = `${supabaseUrl}/functions/v1/bulk-message-generator`;

  return (
    <div className="min-h-screen bg-background text-foreground overflow-y-auto">
      <div className="container mx-auto py-12 px-4 max-w-5xl">
        <div className="mb-10 flex items-center justify-between">
          <div>
            <Button
              variant="ghost"
              onClick={() => setLocation('/')}
              className="mb-4 hover:bg-accent -ml-4 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Dashboard
            </Button>
            <h1 className="text-2xl font-bold tracking-tight flex items-center">
              <Megaphone className="w-6 h-6 mr-3 text-primary" />
              Campaign Manager
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">Create and manage bulk messaging campaigns with AI-generated variations</p>
          </div>
        </div>

        <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <CampaignMessageVariationPanel
            supabaseUrl={supabaseUrl}
            supabaseAnonKey={supabaseAnonKey}
            edgeFunctionUrl={edgeFunctionUrl}
          />
        </div>
      </div>
    </div>
  );
}
