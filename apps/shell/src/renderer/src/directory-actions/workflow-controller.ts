import type { DirectoryWorkflowStatus, DirectoryInteractionReply } from '@genoffice/agent-core';
export class WorkflowController {
    private state: (DirectoryWorkflowStatus & {
        busy: boolean;
        error?: string;
    }) | null = null;
    private listeners = new Set<() => void>();
    private reply: ((value: DirectoryInteractionReply) => Promise<void>) | null = null;
    subscribe = (f: () => void) => { this.listeners.add(f); return () => { this.listeners.delete(f); }; };
    getSnapshot = () => this.state;
    update(status: DirectoryWorkflowStatus, reply: (value: DirectoryInteractionReply) => Promise<void>): void {
        this.reply = reply;
        const sameQuestion = this.state?.interaction?.id === status.interaction?.id;
        this.state = { ...status, busy: sameQuestion && !!this.state?.busy, error: sameQuestion ? this.state?.error : undefined };
        this.listeners.forEach(f => f());
    }
    async decide(value: DirectoryInteractionReply): Promise<void> {
        if (!this.reply || this.state?.interaction?.id !== value.id || this.state.busy)
            return;
        const reply = this.reply;
        this.state = { ...this.state, busy: true, error: undefined };
        this.listeners.forEach(f => f());
        try {
            await reply(value);
            if (this.state?.interaction?.id === value.id)
                this.state = { ...this.state, interaction: null, busy: false };
        }
        catch (error) {
            if (this.state?.interaction?.id === value.id)
                this.state = { ...this.state, busy: false, error: error instanceof Error ? error.message : String(error) };
        }
        this.listeners.forEach(f => f());
    }
    clear(): void { this.reply = null; this.state = null; this.listeners.forEach(f => f()); }
}
