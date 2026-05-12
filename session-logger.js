const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs', 'sessions');

// Создаём папку для логов при первом импорте модуля
function ensureLogDir() {
    try {
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
            console.log(`📁 Создана папка для логов: ${LOG_DIR}`);
        }
        return true;
    } catch (err) {
        console.error(`❌ ОШИБКА: Не могу создать папку логов: ${err.message}`);
        console.error(`   Путь: ${LOG_DIR}`);
        console.error(`   Проверьте права доступа для пользователя ${process.env.USER || 'unknown'}`);
        return false;
    }
}

// Вызываем сразу при загрузке модуля
ensureLogDir();

class SessionLogger {
    constructor(sessionCode, sessionId, quizTitle) {
        this.sessionCode = sessionCode;
        this.sessionId = sessionId;
        this.quizTitle = quizTitle;
        this.startTime = new Date();
        
        // Формируем имя файла
        const dateStr = this.startTime.toISOString()
            .replace(/T/, '_')
            .replace(/:/g, '-')
            .replace(/\..+/, '');
        const shortId = sessionId.substring(0, 8);
        this.logFileName = `session_${sessionCode}_${shortId}_${dateStr}.json`;
        this.logFilePath = path.join(LOG_DIR, this.logFileName);
        
        // Структура лога
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
        
        // Первая запись и сохранение
        this.addEvent('session_created', {
            quizTitle: quizTitle,
            sessionCode: sessionCode
        });
        
        console.log(`📋 Логгер создан: ${this.logFileName}`);
    }
    
    addEvent(eventType, data) {
        const event = {
            timestamp: new Date().toISOString(),
            type: eventType,
            ...data
        };
        
        this.logData.timeline.push(event);
        
        // Обновляем специфичные разделы
        this._updateSection(eventType, data, event.timestamp);
        
        // Сохраняем лог
        this._save();
    }
    
    _updateSection(eventType, data, timestamp) {
        switch(eventType) {
            case 'student_joined':
                if (!this.logData.students[data.studentId]) {
                    this.logData.students[data.studentId] = {
                        id: data.studentId,
                        name: data.studentName || 'Unknown',
                        joinedAt: timestamp,
                        disconnectedAt: null,
                        answers: [],
                        finalScore: 0
                    };
                }
                break;
                
            case 'student_disconnected':
                if (this.logData.students[data.studentId]) {
                    this.logData.students[data.studentId].disconnectedAt = timestamp;
                }
                break;
                
            case 'quiz_started':
                this.logData.sessionInfo.status = 'active';
                break;
                
            case 'question_started':
                this.logData.questions.push({
                    index: data.questionIndex,
                    question: data.questionText,
                    correctAnswer: data.correctAnswer,
                    startedAt: timestamp,
                    endedAt: null,
                    answers: []
                });
                break;
                
            case 'question_ended':
                if (this.logData.questions[data.questionIndex]) {
                    this.logData.questions[data.questionIndex].endedAt = timestamp;
                    this.logData.questions[data.questionIndex].totalAnswers = data.totalAnswers || 0;
                    this.logData.questions[data.questionIndex].correctCount = data.correctCount || 0;
                }
                break;
                
            case 'student_answer':
                if (this.logData.students[data.studentId]) {
                    this.logData.students[data.studentId].answers.push({
                        questionIndex: data.questionIndex,
                        answer: data.answerText,
                        isCorrect: data.isCorrect,
                        timeLeft: data.timeLeft,
                        timestamp: timestamp
                    });
                }
                
                if (this.logData.questions[data.questionIndex]) {
                    this.logData.questions[data.questionIndex].answers.push({
                        studentId: data.studentId,
                        studentName: data.studentName || 'Unknown',
                        answer: data.answerText,
                        isCorrect: data.isCorrect,
                        timeLeft: data.timeLeft
                    });
                }
                break;
                
            case 'score_updated':
                if (this.logData.students[data.studentId]) {
                    this.logData.students[data.studentId].finalScore = data.score;
                }
                break;
                
            case 'quiz_ended':
                this.logData.sessionInfo.status = 'completed';
                this.logData.endedAt = timestamp;
                this.logData.finalResults = data.finalResults;
                
                if (data.stats) {
                    this.logData.sessionInfo.stats = data.stats;
                }
                break;
                
            case 'quiz_aborted':
                this.logData.sessionInfo.status = 'aborted';
                this.logData.endedAt = timestamp;
                this.logData.abortReason = data.reason;
                break;
                
            case 'server_error':
                this.logData.errors.push({
                    timestamp: timestamp,
                    message: data.message,
                    stack: data.stack,
                    context: data.context
                });
                break;
        }
    }
    
    _save() {
        try {
            const jsonData = JSON.stringify(this.logData, null, 2);
            fs.writeFileSync(this.logFilePath, jsonData, 'utf8');
        } catch (error) {
            console.error(`❌ Ошибка сохранения лога ${this.logFileName}:`, error.message);
            console.error(`   Путь: ${this.logFilePath}`);
        }
    }
    
    getLogPath() {
        return this.logFilePath;
    }
    
    getFileName() {
        return this.logFileName;
    }
}

module.exports = SessionLogger;
