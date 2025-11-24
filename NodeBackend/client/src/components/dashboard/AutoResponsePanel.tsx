import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MessageSquare, Trash2, Edit2, Bell, BellOff, Info } from "lucide-react";

interface AutoResponsePanelProps {
    autoResponses: any[];
    onCreate: (data: { keyword: string; response: string }) => void;
    onUpdate: (data: { id: string; keyword?: string; response?: string; isActive?: boolean }) => void;
    onDelete: (id: string) => void;
}

export function AutoResponsePanel({ autoResponses, onCreate, onUpdate, onDelete }: AutoResponsePanelProps) {
    return (
        <Card className="border-none shadow-lg bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm">
            <CardHeader className="flex flex-row items-center justify-between">
                <div>
                    <CardTitle className="text-lg font-semibold">Auto-Responses</CardTitle>
                    <p className="text-sm text-muted-foreground mt-1">Manage keyword-based automatic replies</p>
                </div>
                <Button
                    onClick={() => {
                        const keyword = prompt("Enter keyword (e.g., YES, INTERESTED):");
                        if (!keyword) return;
                        const response = prompt("Enter auto-response message:");
                        if (!response) return;
                        onCreate({ keyword, response });
                    }}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20"
                >
                    Add New
                </Button>
            </CardHeader>
            <CardContent>
                <div className="space-y-4">
                    {autoResponses.length === 0 ? (
                        <div className="text-center py-12 text-muted-foreground bg-accent/20 rounded-xl border border-dashed border-border">
                            <MessageSquare className="w-12 h-12 mx-auto mb-3 text-muted-foreground/50" />
                            <p>No auto-responses configured</p>
                            <p className="text-sm mt-1">Create your first auto-response to get started</p>
                        </div>
                    ) : (
                        autoResponses.map((autoResponse: any) => (
                            <div
                                key={autoResponse.id}
                                className="group bg-white dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800 rounded-xl p-4 hover:border-primary/50 hover:shadow-md transition-all duration-300"
                            >
                                <div className="flex items-start justify-between">
                                    <div className="flex-1">
                                        <div className="flex items-center space-x-2 mb-2">
                                            <Badge variant={autoResponse.isActive === 'true' ? 'default' : 'secondary'} className={autoResponse.isActive === 'true' ? 'bg-primary/10 text-primary hover:bg-primary/20' : ''}>
                                                {autoResponse.keyword}
                                            </Badge>
                                            <span className="text-xs text-muted-foreground">
                                                {autoResponse.isActive === 'true' ? 'Active' : 'Inactive'}
                                            </span>
                                        </div>
                                        <p className="text-sm text-foreground">{autoResponse.response}</p>
                                        <p className="text-xs text-muted-foreground mt-2">
                                            Created: {new Date(autoResponse.createdAt).toLocaleDateString()}
                                        </p>
                                    </div>
                                    <div className="flex items-center space-x-2 ml-4 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => {
                                                const newIsActive = autoResponse.isActive === 'true' ? false : true;
                                                onUpdate({
                                                    id: autoResponse.id,
                                                    isActive: newIsActive
                                                });
                                            }}
                                            className="hover:bg-accent"
                                        >
                                            {autoResponse.isActive === 'true' ? <BellOff className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => {
                                                const newKeyword = prompt("Enter new keyword:", autoResponse.keyword);
                                                if (!newKeyword) return;
                                                const newResponse = prompt("Enter new response:", autoResponse.response);
                                                if (!newResponse) return;
                                                onUpdate({
                                                    id: autoResponse.id,
                                                    keyword: newKeyword,
                                                    response: newResponse
                                                });
                                            }}
                                            className="hover:bg-accent"
                                        >
                                            <Edit2 className="w-4 h-4" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => {
                                                if (confirm(`Delete auto-response for "${autoResponse.keyword}"?`)) {
                                                    onDelete(autoResponse.id);
                                                }
                                            }}
                                            className="text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                <div className="mt-6 p-4 bg-blue-50/50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30 rounded-xl">
                    <h4 className="flex items-center font-medium text-sm text-blue-900 dark:text-blue-300 mb-2">
                        <Info className="w-4 h-4 mr-2" />
                        How Auto-Responses Work
                    </h4>
                    <ul className="text-sm text-blue-800 dark:text-blue-400 space-y-1 ml-6 list-disc">
                        <li>Keywords are matched case-insensitively</li>
                        <li>First matching keyword triggers the response</li>
                        <li>Responses are sent automatically when recipients reply with matching keywords</li>
                        <li>Example: When someone replies "YES", send "Thank you for your interest!"</li>
                    </ul>
                </div>
            </CardContent>
        </Card>
    );
}
