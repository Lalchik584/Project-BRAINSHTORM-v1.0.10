const express = require('express');
const http = require('http');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const socketIo = require('socket.io');
const qr = require('qr-image');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['polling', 'websocket']
});

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';
const DB_FILE = path.join(__dirname, 'quizzes.json');
const FEEDBACK_FILE = path.join(__dirname, 'feedbacks.json');

// ========== БАЗЫ ДАННЫХ ==========
let quizzes = [];
let usedCodes = new Set();
let activeSessions = new Map();

// ========== ФУНКЦИИ РАБОТЫ С ФАЙЛОМ ==========
function loadQuizzesFromFile() {
    try {
        console.log(`📂 Загрузка из файла: ${DB_FILE}`);
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            quizzes = JSON.parse(data);
            quizzes.forEach(quiz => usedCodes.add(quiz.article));
            console.log(`✅ Загружено ${quizzes.length} квизов`);
        } else {
            console.log('📂 Файл не найден, создаю новый');
            fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2));
            quizzes = [];
        }
    } catch (error) {
        console.error('❌ Ошибка загрузки:', error);
        quizzes = [];
    }
}

function saveQuizzesToFile() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(quizzes, null, 2));
        console.log(`✅ Сохранено ${quizzes.length} квизов`);
    } catch (error) {
        console.error('❌ Ошибка сохранения:', error);
    }
}

// ========== ФУНКЦИИ ДЛЯ ОТЗЫВОВ ==========
function loadFeedbacks() {
    try {
        if (fs.existsSync(FEEDBACK_FILE)) {
            const data = fs.readFileSync(FEEDBACK_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('❌ Ошибка загрузки отзывов:', error);
    }
    return [];
}

function saveFeedbacks(feedbacks) {
    try {
        fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(feedbacks, null, 2));
        console.log(`✅ Сохранено ${feedbacks.length} отзывов`);
    } catch (error) {
        console.error('❌ Ошибка сохранения отзывов:', error);
    }
}

loadQuizzesFromFile();

// ========== ФУНКЦИЯ ДЛЯ НАЗВАНИЙ КАТЕГОРИЙ ==========
function getCategoryName(categoryCode) {
    const categories = {
        'math': '📐 Математика',
        'algebra': '🔢 Алгебра',
        'geometry': '📏 Геометрия',
        'informatic': '🖥️ Информатика',
        'russian': '📖 Русский язык',
        'literature': '📚 Литература',
        'reading': '📗 Чтение',
        'english': '🇬🇧 Английский язык',
        'french': '🇫🇷 Французский язык',
        'german': '🇩🇪 Немецкий язык',
        'history': '📜 История',
        'history_russia': '🏛️ История России',
        'social': '👥 Обществознание',
        'geography': '🌏 География',
        'biology': '🧬 Биология',
        'chemistry': '🧪 Химия',
        'physics': '⚡ Физика',
        'ecology': '🌿 Экология',
        'environment': '🌍 Окружающий мир',
        'astronomy': '🔭 Астрономия',
        'art': '🎨 Изобразительное искусство',
        'music': '🎵 Музыка',
        'culture': '🏛️ Мировая художественная культура',
        'pe': '⚽ Физическая культура',
        'obzh': '🛡️ Основы безопасности и защиты Родины',
        'military': '🎖️ Начальная военная подготовка',
        'tech': '🔧 Технология',
        'drafting': '✏️ Черчение',
        'philosophy': '🤔 Философия',
        'psychology': '🧠 Психология',
        'law': '⚖️ Право',
        'economics': '📈 Экономика',
        'statistics': '📊 Теория вероятности и статистики',
        'ethics': '🤝 Основы религиозных культур и светской этики',
        'other': '🎲 Другое'
    };
    return categories[categoryCode] || '📌 Другое';
}

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========
function generateSessionCode() {
    let code;
    do {
        code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (activeSessions.has(code));
    return code;
}

// ========== ФУНКЦИИ КВИЗА ==========
function startQuestion(session, questionIndex) {
    console.log(`📝 Вопрос ${questionIndex + 1} в сессии ${session.code}`);
    
    session.currentQuestion = questionIndex;
    const question = session.quiz.questions[questionIndex];
    
    if (!question) return;
    
    let wrongAnswers = [];
    if (Array.isArray(question.wrongAnswers)) {
        wrongAnswers = question.wrongAnswers;
    } else if (typeof question.wrongAnswers === 'string') {
        wrongAnswers = question.wrongAnswers.split(',').map(s => s.trim()).filter(s => s);
    } else {
        wrongAnswers = [];
    }
    
    if (wrongAnswers.length === 0) {
        wrongAnswers = ['(нет вариантов)'];
    }
    
    const options = [question.correctAnswer, ...wrongAnswers];
    for (let i = options.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [options[i], options[j]] = [options[j], options[i]];
    }
    
    const timeLimit = question.timeLimit || 30;
    
    io.to(session.code).emit('question-started', {
        questionIndex,
        question: {
            question: question.question,
            options,
            timeLimit
        },
        timeLimit
    });
    
    let timeLeft = timeLimit;
    const startTime = Date.now();
    
    const timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        timeLeft = Math.max(0, timeLimit - elapsed);
        
        io.to(session.code).emit('timer-update', { timeLeft });
        
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            endQuestion(session, questionIndex);
        }
    }, 200);
    
    session.currentTimer = timerInterval;
}

function endQuestion(session, questionIndex) {
    if (session.currentTimer) {
        clearInterval(session.currentTimer);
        session.currentTimer = null;
    }
    
    const question = session.quiz.questions[questionIndex];
    const answers = session.answers.get(questionIndex) || new Map();
    const totalCorrect = Array.from(answers.values()).filter(a => a.isCorrect).length;
    
    io.to(session.code).emit('question-ended', {
        questionIndex,
        correctAnswer: question.correctAnswer,
        totalCorrect
    });
    
    setTimeout(() => {
        const nextIndex = questionIndex + 1;
        if (nextIndex < session.quiz.questions.length) {
            startQuestion(session, nextIndex);
        } else {
            endQuiz(session);
        }
    }, 3000);
}

function endQuiz(session) {
    session.status = 'completed';
    
    const finalResults = Array.from(session.scores.entries())
        .map(([studentId, score]) => ({
            studentId,
            score,
            name: session.students.get(studentId)?.name,
            answers: session.studentAnswers?.get(studentId) || []
        }))
        .sort((a, b) => b.score - a.score);
    
    io.to(session.code).emit('quiz-ended', { finalResults });
}

// ========== EXPRESS ROUTES ==========
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API для создания квиза
app.post('/api/quizzes', (req, res) => {
    try {
        const { title, questions, category } = req.body;
        
        if (!title || !questions || questions.length === 0) {
            return res.status(400).json({ success: false, error: 'Заполните все поля' });
        }

        const newQuiz = {
            id: uuidv4(),
            article: Math.floor(1000000 + Math.random() * 9000000).toString(),
            title: title.trim(),
            category: category || 'other',
            questions: questions,
            createdAt: new Date().toISOString(),
            plays: 0
        };

        quizzes.push(newQuiz);
        usedCodes.add(newQuiz.article);
        saveQuizzesToFile();
        
        res.json({ success: true, quiz: newQuiz });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API для получения всех квизов
app.get('/api/quizzes/all', (req, res) => {
    try {
        const quizzesWithCategoryNames = quizzes.map(quiz => ({
            ...quiz,
            categoryName: getCategoryName(quiz.category)
        }));
        res.json({ success: true, quizzes: quizzesWithCategoryNames });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API для поиска квизов
app.get('/api/quizzes/search', (req, res) => {
    try {
        const { query, category } = req.query;
        
        let results = quizzes;
        
        if (query && query.trim() !== '') {
            const searchTerm = query.trim().toLowerCase();
            results = results.filter(quiz => 
                quiz.title.toLowerCase().includes(searchTerm) || 
                quiz.article === searchTerm
            );
        }
        
        if (category && category !== 'all') {
            results = results.filter(quiz => quiz.category === category);
        }
        
        const resultsWithNames = results.map(quiz => ({
            ...quiz,
            categoryName: getCategoryName(quiz.category)
        }));
        
        res.json({ success: true, results: resultsWithNames });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API для создания сессии
app.post('/api/sessions', (req, res) => {
    try {
        const { quizArticle } = req.body;
        const quiz = quizzes.find(q => q.article === quizArticle);
        
        if (!quiz) {
            return res.status(404).json({ success: false, error: 'Квиз не найден' });
        }

        const sessionCode = generateSessionCode();
        const sessionId = uuidv4();

        const session = {
            id: sessionId,
            code: sessionCode,
            quiz,
            teacher: null,
            students: new Map(),
            status: 'waiting',
            currentQuestion: 0,
            scores: new Map(),
            studentAnswers: new Map(),
            answers: new Map(),
            currentTimer: null,
            createdAt: new Date().toISOString()
        };

        activeSessions.set(sessionCode, session);
        
        res.json({ 
            success: true, 
            session: {
                id: sessionId,
                code: sessionCode,
                quiz
            }
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API для получения информации о сессии
app.get('/api/sessions/:code', (req, res) => {
    try {
        const { code } = req.params;
        const session = activeSessions.get(code);
        
        if (!session) {
            return res.status(404).json({ success: false, error: 'Сессия не найдена' });
        }

        res.json({ 
            success: true, 
            session: {
                code: session.code,
                quiz: {
                    ...session.quiz,
                    categoryName: getCategoryName(session.quiz.category)
                },
                students: Array.from(session.students.values()),
                status: session.status,
                currentQuestion: session.currentQuestion,
                scores: Array.from(session.scores.entries()).map(([studentId, score]) => ({
                    studentId,
                    score,
                    name: session.students.get(studentId)?.name
                })),
                detailedAnswers: Array.from(session.studentAnswers?.entries() || [])
            }
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Генерация QR-кода
app.get('/qr/:sessionCode', (req, res) => {
    const sessionCode = req.params.sessionCode;
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const url = `${protocol}://${host}/student.html?session=${sessionCode}`;
    
    const qr_svg = qr.image(url, { type: 'png' });
    res.type('png');
    qr_svg.pipe(res);
});

// Страница управления сессией
app.get('/session/:sessionCode', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'session.html'));
});

// ========== API ДЛЯ ОТЗЫВОВ ==========

// Сохранение отзыва
app.post('/api/feedback', (req, res) => {
    try {
        const { name, text } = req.body;
        
        if (!name || !text || text.length < 5) {
            return res.status(400).json({ success: false, error: 'Некорректные данные' });
        }
        
        const feedbacks = loadFeedbacks();
        feedbacks.push({
            id: uuidv4(),
            name: name.trim(),
            text: text.trim(),
            createdAt: new Date().toISOString()
        });
        
        saveFeedbacks(feedbacks);
        console.log(`📝 Новый отзыв от ${name}`);
        
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Получение всех отзывов (для админа)
app.get('/api/feedbacks', (req, res) => {
    try {
        const feedbacks = loadFeedbacks();
        res.json({ success: true, feedbacks });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== SOCKET.IO ==========
io.on('connection', (socket) => {
    console.log('🔌 Новое подключение:', socket.id);

    socket.on('teacher-join', (sessionCode) => {
        const session = activeSessions.get(sessionCode);
        if (session) {
            session.teacher = socket.id;
            socket.join(sessionCode);
            socket.sessionCode = sessionCode;
            console.log(`👨‍🏫 Учитель в сессии: ${sessionCode}`);
            
            const students = Array.from(session.students.values());
            students.forEach(student => {
                socket.emit('student-joined', {
                    student,
                    totalStudents: session.students.size
                });
            });
        }
    });

    socket.on('student-join', (data) => {
        const { sessionCode, studentName } = data;
        const session = activeSessions.get(sessionCode);
        
        if (session) {
            const studentId = uuidv4();
            const student = {
                id: studentId,
                name: studentName,
                socketId: socket.id,
                joinedAt: new Date().toISOString()
            };
            
            session.students.set(studentId, student);
            session.scores.set(studentId, 0);
            session.studentAnswers.set(studentId, []);
            socket.join(sessionCode);
            socket.sessionCode = sessionCode;
            socket.studentId = studentId;
            
            io.to(sessionCode).emit('student-joined', {
                student,
                totalStudents: session.students.size
            });
            
            console.log(`👨‍🎓 ${studentName} присоединился к ${sessionCode}`);
        }
    });

    socket.on('start-quiz', (sessionCode) => {
        const session = activeSessions.get(sessionCode);
        if (session && session.teacher === socket.id) {
            session.status = 'active';
            session.currentQuestion = 0;
            
            session.scores.clear();
            session.studentAnswers.clear();
            session.students.forEach((_, studentId) => {
                session.scores.set(studentId, 0);
                session.studentAnswers.set(studentId, []);
            });
            session.answers.clear();
            
            io.to(sessionCode).emit('quiz-started');
            
            setTimeout(() => startQuestion(session, 0), 3000);
        }
    });

    socket.on('student-answer', (data) => {
        const { sessionCode, questionIndex, answerIndex, answerText, timeLeft } = data;
        const session = activeSessions.get(sessionCode);
        
        if (session && session.status === 'active' && session.currentQuestion === questionIndex) {
            const studentId = socket.studentId;
            const question = session.quiz.questions[questionIndex];
            
            if (!session.answers.has(questionIndex)) {
                session.answers.set(questionIndex, new Map());
            }
            
            const isCorrect = answerText === question.correctAnswer;
            
            session.answers.get(questionIndex).set(studentId, { 
                answered: true,
                answerIndex,
                isCorrect,
                timeLeft 
            });
            
            if (session.teacher) {
                const answeredCount = session.answers.get(questionIndex).size;
                const totalStudents = session.students.size;
                
                const answeredStudents = [];
                session.answers.get(questionIndex).forEach((value, id) => {
                    const student = session.students.get(id);
                    if (student) {
                        answeredStudents.push({
                            id: student.id,
                            name: student.name,
                            isCorrect: value.isCorrect
                        });
                    }
                });
                
                io.to(session.teacher).emit('answer-status-update', {
                    questionIndex,
                    answeredCount,
                    totalStudents,
                    answeredStudents,
                    pendingCount: totalStudents - answeredCount
                });
            }
            
            const studentAnswers = session.studentAnswers.get(studentId) || [];
            studentAnswers.push({
                questionIndex,
                answerIndex,
                isCorrect,
                timeLeft,
                timestamp: new Date().toISOString()
            });
            session.studentAnswers.set(studentId, studentAnswers);
            
            if (isCorrect) {
                const currentScore = session.scores.get(studentId) || 0;
                session.scores.set(studentId, currentScore + 10);
            }
            
            sendDetailedStats(session);
        }
    });

    socket.on('disconnect', () => {
        if (socket.sessionCode && socket.studentId) {
            const session = activeSessions.get(socket.sessionCode);
            if (session) {
                session.students.delete(socket.studentId);
                io.to(socket.sessionCode).emit('student-left', {
                    studentId: socket.studentId,
                    totalStudents: session.students.size
                });
            }
        }
        console.log('🔌 Отключился:', socket.id);
    });
});

function sendDetailedStats(session) {
    if (!session.teacher) return;
    
    const studentScores = new Map();
    session.studentAnswers.forEach((answers, studentId) => {
        let total = 0;
        answers.forEach(answer => {
            if (answer.isCorrect) total += 10;
        });
        studentScores.set(studentId, total);
    });
    
    const stats = {
        totalStudents: session.students.size,
        questions: session.quiz.questions.map((q, idx) => ({
            text: q.question,
            correctAnswer: q.correctAnswer,
            answers: session.answers.get(idx) ? 
                Array.from(session.answers.get(idx).entries()) : []
        })),
        studentDetails: Array.from(session.studentAnswers.entries()).map(([studentId, answers]) => {
            const student = session.students.get(studentId);
            const score = studentScores.get(studentId) || 0;
            return {
                studentId,
                name: student?.name || `Ученик ${studentId.slice(0, 6)}`,
                answers,
                score: score
            };
        })
    };
    
    io.to(session.teacher).emit('detailed-stats', stats);
}

server.listen(PORT, HOST, () => {
    console.log('🎯 ================================');
    console.log('🎯 BRAINSHTORM SERVER STARTED');
    console.log('🎯 ================================');
    console.log(`🌍 Локальный доступ: http://localhost:${PORT}`);
    console.log(`📁 База данных: ${DB_FILE}`);
    console.log(`📁 Отзывы: ${FEEDBACK_FILE}`);
    console.log(`📊 Загружено квизов: ${quizzes.length}`);
    console.log('🎯 ================================');
});
