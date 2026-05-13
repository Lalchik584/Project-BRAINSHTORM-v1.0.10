const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs', 'sessions');

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
        const timestamp = new Date().toISOString();
        
        this.logData.timeline.push({
            timestamp: timestamp,
            type: type,
            ...data
        });
        
        this._updateSections(type, data, timestamp);
        this.save();
    }
    
    _updateSections(type, data, timestamp) {
        switch(type) {
            case 'student_joined':
                this.logData.students[data.studentId] = {
                    id: data.studentId,
                    name: data.studentName,
                    joinedAt: timestamp,
                    disconnectedAt: null,
                    answers: [],
                    finalScore: 0
                };
                break;
            case 'quiz_started':
                this.logData.sessionInfo.status = 'active';
                break;
            case 'question_started':
                this.logData.questions.push({
                    index: data.questionIndex,
                    question: data.questionText,
                    startedAt: timestamp,
                    answers: []
                });
                break;
            case 'student_answer':
                if (this.logData.students[data.studentId]) {
                    this.logData.students[data.studentId].answers.push({
                        questionIndex: data.questionIndex,
                        answer: data.answerText,
                        isCorrect: data.isCorrect,
                        timeLeft: data.timeLeft
                    });
                }
                break;
            case 'quiz_ended':
                this.logData.sessionInfo.status = 'completed';
                this.logData.endedAt = timestamp;
                this.logData.finalResults = data.finalResults;
                break;
            case 'server_error':
                this.logData.errors.push({
                    timestamp: timestamp,
                    message: data.message
                });
                break;
        }
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
