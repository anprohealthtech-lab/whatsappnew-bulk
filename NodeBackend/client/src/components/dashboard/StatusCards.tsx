import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
    MessageSquare,
    Send,
    FileText,
    AlertTriangle,
    QrCode,
    CheckCircle2,
    XCircle
} from "lucide-react";
import { cn } from "@/lib/utils";

interface StatusCardsProps {
    whatsappStatus: any;
    status: any;
    generateQRMutation: any;
    formatTimestamp: (timestamp: string) => string;
}

export function StatusCards({ whatsappStatus, status, generateQRMutation, formatTimestamp }: StatusCardsProps) {
    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {/* Connection Status */}
            <Card className="border-none shadow-lg bg-gradient-to-br from-white to-gray-50 dark:from-zinc-900 dark:to-zinc-950 relative overflow-hidden group">
                <div className={cn(
                    "absolute top-0 right-0 w-24 h-24 -mr-6 -mt-6 rounded-full opacity-10 transition-transform group-hover:scale-110",
                    whatsappStatus.isConnected ? "bg-green-500" : "bg-red-500"
                )} />
                <CardContent className="p-6 relative z-10">
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <p className="text-sm font-medium text-muted-foreground">Status</p>
                            <p className={cn(
                                "text-2xl font-bold mt-1",
                                whatsappStatus.isConnected ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
                            )}>
                                {whatsappStatus.isConnected ? 'Connected' : 'Disconnected'}
                            </p>
                        </div>
                        <div className={cn(
                            "w-12 h-12 rounded-2xl flex items-center justify-center shadow-sm",
                            whatsappStatus.isConnected ? "bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400" : "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400"
                        )}>
                            <MessageSquare className="text-xl" />
                        </div>
                    </div>

                    <div className="flex items-center text-xs text-muted-foreground">
                        <div className={cn(
                            "w-2 h-2 rounded-full mr-2 animate-pulse",
                            whatsappStatus.isConnected ? "bg-green-500" : "bg-red-500"
                        )} />
                        {whatsappStatus.lastSeen ? `Last seen: ${formatTimestamp(whatsappStatus.lastSeen)}` : 'Never connected'}
                    </div>

                    {!whatsappStatus.isConnected && (
                        <Button
                            size="sm"
                            className="mt-4 w-full bg-primary hover:bg-primary/90 text-primary-foreground shadow-md shadow-primary/20"
                            onClick={() => generateQRMutation.mutate()}
                            disabled={generateQRMutation.isPending}
                        >
                            <QrCode className="w-4 h-4 mr-2" />
                            Connect Now
                        </Button>
                    )}
                </CardContent>
            </Card>

            {/* Messages Today */}
            <Card className="border-none shadow-lg bg-gradient-to-br from-white to-gray-50 dark:from-zinc-900 dark:to-zinc-950 relative overflow-hidden group">
                <div className="absolute top-0 right-0 w-24 h-24 -mr-6 -mt-6 rounded-full bg-blue-500 opacity-10 transition-transform group-hover:scale-110" />
                <CardContent className="p-6 relative z-10">
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <p className="text-sm font-medium text-muted-foreground">Sent Today</p>
                            <p className="text-2xl font-bold text-foreground mt-1">
                                {status?.stats?.sentToday || 0}
                            </p>
                        </div>
                        <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-2xl flex items-center justify-center shadow-sm">
                            <Send className="text-xl" />
                        </div>
                    </div>
                    <div className="flex items-center text-xs text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/30 px-2 py-1 rounded-md w-fit">
                        <CheckCircle2 className="w-3 h-3 mr-1" />
                        +{status?.stats?.deliveredToday || 0} delivered
                    </div>
                </CardContent>
            </Card>

            {/* Total Messages */}
            <Card className="border-none shadow-lg bg-gradient-to-br from-white to-gray-50 dark:from-zinc-900 dark:to-zinc-950 relative overflow-hidden group">
                <div className="absolute top-0 right-0 w-24 h-24 -mr-6 -mt-6 rounded-full bg-purple-500 opacity-10 transition-transform group-hover:scale-110" />
                <CardContent className="p-6 relative z-10">
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <p className="text-sm font-medium text-muted-foreground">Total Messages</p>
                            <p className="text-2xl font-bold text-foreground mt-1">
                                {status?.stats?.totalMessages || 0}
                            </p>
                        </div>
                        <div className="w-12 h-12 bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 rounded-2xl flex items-center justify-center shadow-sm">
                            <FileText className="text-xl" />
                        </div>
                    </div>
                    <div className="flex items-center text-xs text-muted-foreground">
                        <span className="bg-gray-100 dark:bg-zinc-800 px-2 py-1 rounded-md">
                            {status?.stats?.pendingCount || 0} pending
                        </span>
                    </div>
                </CardContent>
            </Card>

            {/* Failed Messages */}
            <Card className="border-none shadow-lg bg-gradient-to-br from-white to-gray-50 dark:from-zinc-900 dark:to-zinc-950 relative overflow-hidden group">
                <div className="absolute top-0 right-0 w-24 h-24 -mr-6 -mt-6 rounded-full bg-red-500 opacity-10 transition-transform group-hover:scale-110" />
                <CardContent className="p-6 relative z-10">
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <p className="text-sm font-medium text-muted-foreground">Failed</p>
                            <p className="text-2xl font-bold text-red-600 dark:text-red-400 mt-1">
                                {status?.stats?.failedToday || 0}
                            </p>
                        </div>
                        <div className="w-12 h-12 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-2xl flex items-center justify-center shadow-sm">
                            <AlertTriangle className="text-xl" />
                        </div>
                    </div>
                    <div className="flex items-center text-xs text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/30 px-2 py-1 rounded-md w-fit">
                        <XCircle className="w-3 h-3 mr-1" />
                        Action required
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
