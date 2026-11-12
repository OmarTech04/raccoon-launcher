// Explicit AI mode ("c <question>"). Typing only produces a preview row;
// nothing is launched or sent until the row is activated (Enter / click).
export class AiProvider {
    /** @param {{open: Function}} controller - an AiWindowController */
    constructor(controller) {
        this._controller = controller;
    }

    query(text) {
        if (!text)
            return [];
        return [{
            id: 'ai-chatgpt',
            name: `Ask ChatGPT: “${text}”`,
            description: 'Enter opens a new ChatGPT Temporary Chat in Firefox and sends this question',
            iconName: 'chat-message-new-symbolic',
            score: 1000,
            activate: () => this._controller.open(text),
        }];
    }

    destroy() {
        this._controller = null;
    }
}
