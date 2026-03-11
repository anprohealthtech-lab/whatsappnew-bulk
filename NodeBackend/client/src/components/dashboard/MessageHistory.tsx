import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Search,
    RefreshCw,
    CheckCircle,
    Send,
    AlertTriangle,
    XCircle,
    FileText,
    MessageSquare,
    Eye
} from "lucide-react";

interface MessageHistoryProps {
    messages: any[];
    isLoading: boolean;
    filters: any;
    onFilterChange: (key: string, value: string) => void;
    onResend: (id: string) => void;
    formatTimestamp: (timestamp: string) => string;
}

export function MessageHistory({ messages, isLoading, filters, onFilterChange, onResend, formatTimestamp }: MessageHistoryProps) {
    const [selectedMessage, setSelectedMessage] = useState<any>(null);

    const getStatusBadge = (status: string) => {
        switch (status) {
            case 'delivered':
                return <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 hover:bg-green-200"><CheckCircle className="w-3 h-3 mr-1" />Delivered</Badge>;
            case 'sent':
                return <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 hover:bg-blue-200"><Send className="w-3 h-3 mr-1" />Sent</Badge>;
            case 'pending':
                return <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400 hover:bg-yellow-200"><AlertTriangle className="w-3 h-3 mr-1" />Pending</Badge>;
            case 'failed':
                return <Badge className="bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400 hover:bg-red-200"><XCircle className="w-3 h-3 mr-1" />Failed</Badge>;
            default:
                return <Badge variant="outline">{status}</Badge>;
        }
    };

    const getTypeIcon = (type: string) => {
        switch (type) {
            case 'report':
                return <FileText className="w-4 h-4 text-purple-500" />;
            case 'text':
                return <MessageSquare className="w-4 h-4 text-blue-500" />;
            default:
                return <FileText className="w-4 h-4 text-gray-500" />;
        }
    };

    return (
        <Card className="border-none shadow-lg bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm">
            <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-lg font-semibold">Message History</CardTitle>
                <div className="flex items-center space-x-3">
                    <Select
                        value={filters.status}
                        onValueChange={(value) => onFilterChange('status', value)}
                    >
                        <SelectTrigger className="w-40 bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Status</SelectItem>
                            <SelectItem value="delivered">Delivered</SelectItem>
                            <SelectItem value="sent">Sent</SelectItem>
                            <SelectItem value="pending">Pending</SelectItem>
                            <SelectItem value="failed">Failed</SelectItem>
                        </SelectContent>
                    </Select>

                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
                        <Input
                            placeholder="Search messages..."
                            value={filters.search}
                            onChange={(e) => onFilterChange('search', e.target.value)}
                            className="pl-10 w-64 bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800"
                        />
                    </div>
                </div>
            </CardHeader>
            <CardContent>
                <div className="overflow-auto rounded-xl border border-gray-200 dark:border-zinc-800">
                    <table className="w-full text-sm">
                        <thead className="bg-gray-50 dark:bg-zinc-900/50">
                            <tr>
                                <th className="text-left py-4 px-6 font-medium text-muted-foreground">Timestamp</th>
                                <th className="text-left py-4 px-6 font-medium text-muted-foreground">Recipient</th>
                                <th className="text-left py-4 px-6 font-medium text-muted-foreground">Type</th>
                                <th className="text-left py-4 px-6 font-medium text-muted-foreground">Content</th>
                                <th className="text-left py-4 px-6 font-medium text-muted-foreground">Status</th>
                                <th className="text-left py-4 px-6 font-medium text-muted-foreground">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200 dark:divide-zinc-800 bg-white dark:bg-zinc-950">
                            {isLoading ? (
                                <>
                                    {[...Array(5)].map((_, i) => (
                                        <tr key={i}>
                                            <td className="py-4 px-6"><Skeleton className="h-4 w-32" /></td>
                                            <td className="py-4 px-6"><Skeleton className="h-4 w-28" /></td>
                                            <td className="py-4 px-6"><Skeleton className="h-4 w-16" /></td>
                                            <td className="py-4 px-6"><Skeleton className="h-4 w-40" /></td>
                                            <td className="py-4 px-6"><Skeleton className="h-6 w-20 rounded-full" /></td>
                                            <td className="py-4 px-6"><Skeleton className="h-8 w-16" /></td>
                                        </tr>
                                    ))}
                                </>
                            ) : messages.length === 0 ? (
                                <tr>
                                    <td colSpan={6} className="py-12 text-center text-muted-foreground">
                                        No messages found matching your criteria
                                    </td>
                                </tr>
                            ) : (
                                messages.map((msg: any) => (
                                    <tr key={msg.id} className="hover:bg-gray-50 dark:hover:bg-zinc-900/50 transition-colors">
                                        <td className="py-4 px-6 text-muted-foreground whitespace-nowrap">
                                            {formatTimestamp(msg.createdAt)}
                                        </td>
                                        <td className="py-4 px-6 font-medium text-foreground">
                                            {msg.to}
                                        </td>
                                        <td className="py-4 px-6">
                                            <div className="flex items-center space-x-2">
                                                {getTypeIcon(msg.type)}
                                                <span className="capitalize text-muted-foreground">{msg.type}</span>
                                            </div>
                                        </td>
                                        <td className="py-4 px-6 max-w-xs truncate text-muted-foreground" title={msg.content}>
                                            {msg.content}
                                        </td>
                                        <td className="py-4 px-6">
                                            {getStatusBadge(msg.status)}
                                        </td>
                                        <td className="py-4 px-6">
                                            <div className="flex items-center space-x-2">
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => setSelectedMessage(msg)}
                                                    className="text-blue-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                                                >
                                                    <Eye className="w-4 h-4 mr-1" />
                                                    View
                                                </Button>
                                                {msg.status === 'failed' && (
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={() => onResend(msg.id)}
                                                        className="text-primary hover:text-primary hover:bg-primary/10"
                                                    >
                                                        <RefreshCw className="w-4 h-4 mr-1" />
                                                        Resend
                                                    </Button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </CardContent >

            <Dialog open={!!selectedMessage} onOpenChange={(open) => !open && setSelectedMessage(null)}>
                <DialogContent className="sm:max-w-[600px]">
                    <DialogHeader>
                        <DialogTitle>Message Details</DialogTitle>
                        <DialogDescription>
                            View full message content and metadata
                        </DialogDescription>
                    </DialogHeader>

                    {selectedMessage && (
                        <div className="space-y-4">
                            <div className="grid grid-cols-2 gap-4 text-sm">
                                <div>
                                    <span className="font-semibold text-muted-foreground">Status:</span>
                                    <div className="mt-1">{getStatusBadge(selectedMessage.status)}</div>
                                </div>
                                <div>
                                    <span className="font-semibold text-muted-foreground">Type:</span>
                                    <div className="mt-1 flex items-center">
                                        {getTypeIcon(selectedMessage.type)}
                                        <span className="ml-2 capitalize">{selectedMessage.type}</span>
                                    </div>
                                </div>
                                <div>
                                    <span className="font-semibold text-muted-foreground">Recipient:</span>
                                    <div className="mt-1 font-mono">{selectedMessage.to || selectedMessage.phoneNumber}</div>
                                </div>
                                <div>
                                    <span className="font-semibold text-muted-foreground">Timestamp:</span>
                                    <div className="mt-1">{formatTimestamp(selectedMessage.createdAt)}</div>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <span className="font-semibold text-muted-foreground text-sm">Content:</span>
                                <div className="p-4 bg-muted/50 rounded-lg text-sm whitespace-pre-wrap max-h-[300px] overflow-y-auto border border-border">
                                    {selectedMessage.content}
                                </div>
                            </div>

                            {selectedMessage.metadata && (
                                <div className="space-y-2">
                                    <span className="font-semibold text-muted-foreground text-sm">Metadata:</span>
                                    <pre className="p-4 bg-muted/50 rounded-lg text-xs font-mono overflow-x-auto border border-border">
                                        {JSON.stringify(selectedMessage.metadata, null, 2)}
                                    </pre>
                                </div>
                            )}
                        </div>
                    )}

                    <DialogFooter>
                        <Button onClick={() => setSelectedMessage(null)}>Close</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Card >
    );
}
