const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs', 'sessions');

// Создаём папку для логов
try {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
} catch (err) {
    console.error('Не могу создать папку логов:', err.message);
}

class SessionLogger {
    constructor(sessionCode, sessionId, quizTitle) {
        this.sessionCode = sessionCode;
        this.sessionId = sessionId;
        this.quizTitle = quizTitle;
        this.startTime = new Date();
        
        const dateStr = this.startTime.toISOString()
            .replace(/T/, '_')
            .replace(/:/g, '-')
            .replace(/\..+/, '');
        const shortId = sessionId.substring(0, 8);
        this.logFileName = `session_${sessionCode}_${shortId}_${dateStr}.json`;
        this.logFilePath = path.join(LOG_DIR, this.logFileName);
        
        this.logData = {
            sessionInfo: {
                code: sessionCode,
                id: sessionId,
                quizTitle: quizTitle,
                startedAt: this.startTime.toISOString(),
                status: 'created'
            },
            timeline: [],
            students: {},
            questions: [],
            errors: [],
            finalResults: null,
            endedAt: null
        };
        
        this.addEvent('session_created', {});
        console.log('Логгер создан:', this.logFileName);
    }
    
    addEvent(type, data) {
        this.logData.timeline.push({
            timestamp: new Date().toISOString(),
            type: type,
            ...data
        });
        this.save();
    }
    
    save() {
        try {
            fs.writeFileSync(this.logFilePath, JSON.stringify(this.logData, null, 2));
        } catch (err) {
            console.error('Ошибка сохранения лога:', err.message);
        }
    }
}

module.exports = SessionLogger;
