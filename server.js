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

// ВАЖНО: Используем абсолютный путь для Render
const DB_FILE = path.join(__dirname, 'quizzes.json');

// Базы данных
let quizzes = [];
let usedCodes = new Set();
let activeSessions = new Map();

// ========== ФУНКЦИИ РАБОТЫ С ФАЙЛОМ ==========

// Загрузка квизов из файла
function loadQuizzesFromFile() {
    try {
        console.log(`📂 Попытка загрузки из файла: ${DB_FILE}`);
        
        // Проверяем существует ли файл
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            quizzes = JSON.parse(data);
            quizzes.forEach(quiz => usedCodes.add(quiz.article));
            console.log(`✅ Загружено ${quizzes.length} квизов из файла`);
        } else {
            console.log('📂 Файл quizzes.json не найден, создаем новый');
            // Создаем пустой файл
            fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2));
            quizzes = [];
        }
    } catch (error) {
        console.error('❌ Ошибка загрузки квизов:', error);
        quizzes = [];
    }
}

// Сохранение квизов в файл
function saveQuizzesToFile() {
    try {
        // Проверяем директорию
        const dir = path.dirname(DB_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        // Сохраняем с форматированием
        fs.writeFileSync(DB_FILE, JSON.stringify(quizzes, null, 2));
        console.log(`✅ Сохранено ${quizzes.length} квизов в файл`);
        
        // Проверяем что файл создался
        if (fs.existsSync(DB_FILE)) {
            const stats = fs.statSync(DB_FILE);
            console.log(`📁 Размер файла: ${stats.size} байт`);
        }
    } catch (error) {
        console.error('❌ Ошибка сохранения квизов:', error);
    }
}

// Функция для просмотра содержимого БД (отладка)
function debugDatabase() {
    console.log('\n=== 🔍 ОТЛАДКА БАЗЫ ДАННЫХ ===');
    console.log(`📁 Файл: ${DB_FILE}`);
    console.log(`📊 Квизов в памяти: ${quizzes.length}`);
    
    if (fs.existsSync(DB_FILE)) {
        try {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            const fileQuizzes = JSON.parse(data);
            console.log(`📊 Квизов в файле: ${fileQuizzes.length}`);
            
            // Показываем первые 3 квиза
            fileQuizzes.slice(0, 3).forEach((quiz, i) => {
                console.log(`\n📋 Квиз ${i + 1}:`);
                console.log(`   Название: ${quiz.title}`);
                console.log(`   Артикул: ${quiz.article}`);
                console.log(`   Вопросов: ${quiz.questions.length}`);
                console.log(`   Создан: ${quiz.createdAt}`);
            });
            
            if (fileQuizzes.length > 3) {
                console.log(`   ... и еще ${fileQuizzes.length - 3}`);
            }
        } catch (e) {
            console.error('❌ Ошибка чтения файла:', e.message);
        }
    } else {
        console.log('❌ Файл не существует');
    }
    console.log('================================\n');
}

// Загружаем при старте
loadQuizzesFromFile();

// Периодически проверяем состояние БД (каждые 30 секунд)
setInterval(debugDatabase, 30000);

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ КВИЗА ==========

function generateSessionCode() {
    let code;
    do {
        code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (activeSessions.has(code));
    return code;
}

// Функция начала вопроса
function startQuestion(session, questionIndex) {
    console.log(`📝 Начинаем вопрос ${questionIndex} в сессии ${session.code}`);
    
    session.currentQuestion = questionIndex;
    const question = session.quiz.questions[questionIndex];
    
    if (!question) {
        console.error(`❌ Вопрос ${questionIndex} не найден`);
        return;
    }
    
    // Создаем перемешанные варианты ответов
    const options = [
        question.correctAnswer,
        ...question.wrongAnswers
    ];
    
    // Перемешиваем варианты
    for (let i = options.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [options[i], options[j]] = [options[j], options[i]];
    }
    
    const timeLimit = 30;
    
    // Отправляем вопрос
    if (session.teacher) {
        io.to(session.code).except(session.teacher).emit('question-started', {
            questionIndex: questionIndex,
            question: {
                question: question.question,
                options: options
            },
            timeLimit: timeLimit
        });
        
        io.to(session.teacher).emit('question-started', {
            questionIndex: questionIndex,
            question: {
                question: question.question,
                options: options
            },
            timeLimit: timeLimit
        });
    } else {
        io.to(session.code).emit('question-started', {
            questionIndex: questionIndex,
            question: {
                question: question.question,
                options: options
            },
            timeLimit: timeLimit
        });
    }
    
    // Запускаем таймер
    let timeLeft = timeLimit;
    const timerInterval = setInterval(() => {
        timeLeft--;
        
        if (session.teacher) {
            io.to(session.code).except(session.teacher).emit('timer-update', { timeLeft: timeLeft });
            io.to(session.teacher).emit('timer-update', { timeLeft: timeLeft });
        } else {
            io.to(session.code).emit('timer-update', { timeLeft: timeLeft });
        }
        
        sendAnswerStats(session, questionIndex);
        
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            endQuestion(session, questionIndex);
        }
    }, 1000);
    
    session.currentTimer = timerInterval;
    console.log(`✅ Вопрос ${questionIndex} отправлен`);
}

// Функция завершения вопроса
function endQuestion(session, questionIndex) {
    console.log(`⏰ Завершаем вопрос ${questionIndex}`);
    
    const question = session.quiz.questions[questionIndex];
    
    if (session.currentTimer) {
        clearInterval(session.currentTimer);
        session.currentTimer = null;
    }
    
    const totalCorrect = Array.from(session.answers.get(questionIndex)?.values() || [])
        .filter(answer => answer === 0).length;
    
    if (session.teacher) {
        io.to(session.code).except(session.teacher).emit('question-ended', {
            questionIndex: questionIndex,
            correctAnswer: question.correctAnswer,
            totalCorrect: totalCorrect
        });
        
        io.to(session.teacher).emit('question-ended', {
            questionIndex: questionIndex,
            correctAnswer: question.correctAnswer,
            totalCorrect: totalCorrect
        });
    } else {
        io.to(session.code).emit('question-ended', {
            questionIndex: questionIndex,
            correctAnswer: question.correctAnswer,
            totalCorrect: totalCorrect
        });
    }
    
    console.log(`❓ Вопрос ${questionIndex + 1} завершен в сессии: ${session.code}`);
    
    setTimeout(() => {
        const nextQuestionIndex = questionIndex + 1;
        if (nextQuestionIndex < session.quiz.questions.length) {
            startQuestion(session, nextQuestionIndex);
        } else {
            endQuiz(session);
        }
    }, 5000);
}

// Функция завершения квиза
function endQuiz(session) {
    console.log(`🏁 Завершаем квиз в сессии ${session.code}`);
    
    session.status = 'completed';
    
    const finalResults = Array.from(session.scores.entries())
        .map(([studentId, score]) => ({
            studentId,
            score,
            name: session.students.get(studentId)?.name
        }))
        .sort((a, b) => b.score - a.score);
    
    io.to(session.code).emit('quiz-ended', { finalResults: finalResults });
    
    console.log(`🏁 Квиз завершен в сессии: ${session.code}`);
}

// Функция отправки статистики ответов
function sendAnswerStats(session, questionIndex) {
    const answers = session.answers.get(questionIndex);
    const answersReceived = answers ? answers.size : 0;
    const correctAnswers = answers ? Array.from(answers.values()).filter(answer => answer === 0).length : 0;
    
    if (session.teacher) {
        io.to(session.teacher).emit('answer-stats', {
            questionIndex: questionIndex,
            answersReceived: answersReceived,
            totalStudents: session.students.size,
            correctAnswers: correctAnswers
        });
    }
}

// Функция обновления таблицы лидеров
function updateLeaderboard(session) {
    const leaderboard = Array.from(session.scores.entries())
        .map(([studentId, score]) => ({
            studentId,
            score,
            name: session.students.get(studentId)?.name
        }))
        .sort((a, b) => b.score - a.score);
    
    if (session.teacher) {
        io.to(session.teacher).emit('leaderboard-update', { leaderboard: leaderboard });
    }
}

// Запуск квиза через консоль
function startQuizViaConsole(session) {
    if (session.status === 'active') {
        console.log('⚠️ Квиз уже запущен');
        return;
    }
    
    session.status = 'active';
    session.currentQuestion = 0;
    
    session.scores.clear();
    session.students.forEach((student, studentId) => {
        session.scores.set(studentId, 0);
    });
    
    session.answers.clear();
    
    io.to(session.code).emit('quiz-started');
    console.log(`✅ Квиз "${session.quiz.title}" начат в сессии: ${session.code}`);
    
    setTimeout(() => {
        startQuestion(session, 0);
    }, 3000);
}

// ========== EXPRESS ROUTES ==========

app.use(express.json());
app.use(express.static('public'));

// Главная страница
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>Quiz App</title>
        <style>body { font-family: Arial; margin: 40px; text-align: center; }</style>
    </head>
    <body>
        <h1>🎯 Quiz Master Platform</h1>
        <p>Сервер запущен на Render!</p>
        <a href="/teacher.html">👨‍🏫 Teacher Panel</a> | 
        <a href="/student.html">👨‍🎓 Student Access</a>
    </body>
    </html>
    `);
});

// API для создания квиза
app.post('/api/quizzes', (req, res) => {
    try {
        console.log('📝 Получен запрос на создание квиза');
        
        const { title, questions } = req.body;
        
        if (!title || !questions || questions.length === 0) {
            console.log('❌ Неполные данные квиза');
            return res.status(400).json({ success: false, error: 'Title and questions are required' });
        }

        const newQuiz = {
            id: uuidv4(),
            article: Math.floor(1000000 + Math.random() * 9000000).toString(),
            title: title.trim(),
            questions: questions,
            createdAt: new Date().toISOString(),
            plays: 0
        };

        // Добавляем в память
        quizzes.push(newQuiz);
        usedCodes.add(newQuiz.article);
        
        // Сохраняем в файл
        saveQuizzesToFile();
        
        console.log(`✅ Квиз создан: ${newQuiz.title} (артикул: ${newQuiz.article})`);
        console.log(`📊 Всего квизов в БД: ${quizzes.length}`);
        
        res.json({ success: true, quiz: newQuiz });
        
    } catch (error) {
        console.error('❌ Ошибка создания квиза:', error);
        res.status(500).json({ success: false, error: 'Server error: ' + error.message });
    }
});

// API для поиска квизов
app.get('/api/quizzes/search', (req, res) => {
    try {
        const { query } = req.query;
        
        if (!query || query.trim() === '') {
            return res.json({ success: true, results: [] });
        }
        
        const searchTerm = query.trim().toLowerCase();
        
        // Сначала загружаем свежие данные из файла
        loadQuizzesFromFile();
        
        const searchResults = quizzes.filter(quiz => {
            const titleMatch = quiz.title.toLowerCase().includes(searchTerm);
            const articleMatch = quiz.article === searchTerm;
            return titleMatch || articleMatch;
        });
        
        console.log(`🔍 Поиск: "${searchTerm}", найдено: ${searchResults.length} квизов`);
        
        res.json({ 
            success: true, 
            results: searchResults 
        });
        
    } catch (error) {
        console.error('❌ Ошибка поиска квизов:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Search error: ' + error.message 
        });
    }
});

// API для создания сессии
app.post('/api/sessions', (req, res) => {
    try {
        const { quizArticle } = req.body;
        
        // Обновляем данные из файла
        loadQuizzesFromFile();
        
        const quiz = quizzes.find(q => q.article === quizArticle);
        
        if (!quiz) {
            console.log(`❌ Квиз с артикулом ${quizArticle} не найден`);
            return res.status(404).json({ success: false, error: 'Quiz not found' });
        }

        const sessionCode = generateSessionCode();
        const sessionId = uuidv4();

        const session = {
            id: sessionId,
            code: sessionCode,
            quiz: quiz,
            teacher: null,
            students: new Map(),
            status: 'waiting',
            currentQuestion: 0,
            scores: new Map(),
            answers: new Map(),
            currentTimer: null,
            createdAt: new Date().toISOString()
        };

        activeSessions.set(sessionCode, session);
        
        console.log(`🎮 Создана сессия: ${sessionCode} для квиза: ${quiz.title}`);
        
        res.json({ 
            success: true, 
            session: {
                id: sessionId,
                code: sessionCode,
                quiz: quiz
            }
        });
        
    } catch (error) {
        console.error('❌ Ошибка создания сессии:', error);
        res.status(500).json({ success: false, error: 'Session creation error' });
    }
});

// API для получения информации о сессии
app.get('/api/sessions/:code', (req, res) => {
    try {
        const { code } = req.params;
        const session = activeSessions.get(code);
        
        if (!session) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

        res.json({ 
            success: true, 
            session: {
                code: session.code,
                quiz: session.quiz,
                students: Array.from(session.students.values()),
                status: session.status,
                currentQuestion: session.currentQuestion,
                scores: Array.from(session.scores.entries()).map(([studentId, score]) => ({
                    studentId,
                    score,
                    name: session.students.get(studentId)?.name
                })).sort((a, b) => b.score - a.score)
            }
        });
        
    } catch (error) {
        console.error('❌ Ошибка получения информации о сессии:', error);
        res.status(500).json({ success: false, error: 'Session error' });
    }
});

// Генерация QR-кода для сессии
app.get('/qr/:sessionCode', (req, res) => {
    const sessionCode = req.params.sessionCode;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const url = `${protocol}://${host}/student.html?session=${sessionCode}`;
    
    console.log(`🔗 Генерируем QR для: ${url}`);
    
    const qr_svg = qr.image(url, { type: 'png' });
    res.type('png');
    qr_svg.pipe(res);
});

// Страница управления сессии
app.get('/session/:sessionCode', (req, res) => {
    const sessionCode = req.params.sessionCode;
    const session = activeSessions.get(sessionCode);
    
    if (!session) {
        return res.status(404).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>Session Not Found</title>
                <style>
                    body { font-family: Arial; margin: 40px; text-align: center; background: #f5f5f5; }
                    .error { color: red; font-size: 1.2em; }
                </style>
            </head>
            <body>
                <h1>❌ Session Not Found</h1>
                <p class="error">Session with code "${sessionCode}" was not found.</p>
                <p>It may have expired or was never created.</p>
                <a href="/teacher.html">← Back to Teacher Panel</a>
            </body>
            </html>
        `);
    }

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>Session ${sessionCode} - ${session.quiz.title}</title>
        <style>
            body { font-family: Arial; margin: 40px; text-align: center; background: #f5f5f5; }
            .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .session-code { font-size: 2em; font-weight: bold; margin: 20px; color: #333; }
            .btn { background: #28a745; color: white; padding: 15px 30px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; margin: 10px; transition: background 0.3s; }
            .btn:hover { background: #218838; }
            .btn:disabled { background: #ccc; cursor: not-allowed; }
            .btn-started { background: #6c757d; }
            .status { font-size: 1.2em; margin: 15px 0; }
            .status-waiting { color: #ffc107; }
            .status-active { color: #28a745; }
            .status-completed { color: #6c757d; }
            .students-list { text-align: left; margin: 20px 0; }
            .student-item { padding: 10px; margin: 5px 0; background: #f8f9fa; border-radius: 5px; border-left: 4px solid #007bff; }
            .info-box { background: #e8f4fd; padding: 15px; border-radius: 5px; margin: 20px 0; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🎮 Session Control Panel</h1>
            <h2>${session.quiz.title}</h2>
            
            <div class="info-box">
                <div class="session-code">Session Code: ${sessionCode}</div>
                <div class="status status-${session.status}">
                    Status: <strong>${session.status.toUpperCase()}</strong>
                </div>
                <p>Total Questions: ${session.quiz.questions.length}</p>
                <p>Connected Students: <span id="students-count">${session.students.size}</span></p>
            </div>
            
            <div class="students-list">
                <h3>👨‍🎓 Connected Students:</h3>
                <div id="students-container">
                    ${session.students.size === 0 ? 
                        '<p id="no-students">No students connected yet...</p>' : 
                        Array.from(session.students.values()).map(student => `
                            <div class="student-item" id="student-${student.id}">
                                <strong>${student.name}</strong>
                                <div style="color: #666; font-size: 0.9em;">
                                    Joined at ${new Date(student.joinedAt).toLocaleTimeString()}
                                </div>
                            </div>
                        `).join('')
                    }
                </div>
            </div>
            
            <div style="margin: 30px 0;">
                <button class="btn ${session.status === 'active' ? 'btn-started' : ''}" 
                        id="startBtn" 
                        onclick="startQuiz()"
                        ${session.status === 'active' ? 'disabled' : ''}>
                    ${session.status === 'active' ? '✅ Quiz Started' : '🚀 Start Quiz'}
                </button>
                
                ${session.status === 'active' ? `
                    <button class="btn" id="nextBtn" onclick="nextQuestion()">⏭️ Next Question</button>
                    <button class="btn" id="endBtn" onclick="endQuiz()">🏁 End Quiz</button>
                ` : ''}
            </div>
            
            <div id="result" style="min-height: 30px;"></div>
            
            <div class="info-box">
                <h4>📱 How students can join:</h4>
                <p>1. Go to: <code>${req.protocol}://${req.get('host')}/student.html</code></p>
                <p>2. Enter session code: <strong>${sessionCode}</strong></p>
                <p>3. Or scan QR code below:</p>
                <img src="/qr/${sessionCode}" alt="QR Code" style="border: 1px solid #ddd; padding: 10px; background: white; max-width: 200px;">
            </div>
        </div>
        
        <script src="/socket.io/socket.io.js"></script>
        <script>
            const socket = io();
            const sessionCode = '${sessionCode}';
            const startBtn = document.getElementById('startBtn');
            const resultDiv = document.getElementById('result');
            
            socket.emit('teacher-join', sessionCode);
            
            function startQuiz() {
                startBtn.disabled = true;
                startBtn.textContent = 'Starting...';
                resultDiv.innerHTML = '<p>Starting quiz...</p>';
                socket.emit('start-quiz', sessionCode);
            }
            
            function nextQuestion() {
                socket.emit('next-question', sessionCode);
                resultDiv.innerHTML = '<p>Moving to next question...</p>';
            }
            
            function endQuiz() {
                socket.emit('end-quiz', sessionCode);
                resultDiv.innerHTML = '<p>Ending quiz...</p>';
            }
            
            socket.on('quiz-started', () => {
                startBtn.textContent = '✅ Quiz Started';
                startBtn.className = 'btn btn-started';
                startBtn.disabled = true;
                resultDiv.innerHTML = '<p style="color: green;">✅ Quiz started successfully!</p>';
                
                const nextBtn = document.getElementById('nextBtn');
                const endBtn = document.getElementById('endBtn');
                if (nextBtn) nextBtn.style.display = 'inline-block';
                if (endBtn) endBtn.style.display = 'inline-block';
                
                const statusEl = document.querySelector('.status');
                statusEl.innerHTML = 'Status: <strong>ACTIVE</strong>';
                statusEl.className = 'status status-active';
            });
            
            socket.on('error', (data) => {
                startBtn.disabled = false;
                startBtn.textContent = '🚀 Start Quiz (Retry)';
                resultDiv.innerHTML = '<p style="color: red;">❌ Error: ' + (data.message || 'Unknown error') + '</p>';
            });
            
            socket.on('student-joined', (data) => {
                const noStudents = document.getElementById('no-students');
                if (noStudents) noStudents.remove();
                
                const student = data.student;
                if (!document.getElementById('student-' + student.id)) {
                    const studentElement = document.createElement('div');
                    studentElement.className = 'student-item';
                    studentElement.id = 'student-' + student.id;
                    studentElement.innerHTML = \`
                        <strong>\${student.name}</strong>
                        <div style="color: #666; font-size: 0.9em;">
                            Joined at \${new Date(student.joinedAt).toLocaleTimeString()}
                        </div>
                    \`;
                    document.getElementById('students-container').appendChild(studentElement);
                }
                document.getElementById('students-count').textContent = data.totalStudents;
            });
            
            socket.on('student-left', (data) => {
                const element = document.getElementById('student-' + data.studentId);
                if (element) element.remove();
                document.getElementById('students-count').textContent = data.totalStudents;
            });
            
            socket.on('quiz-ended', () => {
                resultDiv.innerHTML = '<p style="color: green;">✅ Quiz completed successfully!</p>';
                const statusEl = document.querySelector('.status');
                statusEl.innerHTML = 'Status: <strong>COMPLETED</strong>';
                statusEl.className = 'status status-completed';
                
                const nextBtn = document.getElementById('nextBtn');
                const endBtn = document.getElementById('endBtn');
                if (nextBtn) nextBtn.style.display = 'none';
                if (endBtn) endBtn.style.display = 'none';
            });
            
            window.forceStartQuiz = function() {
                socket.emit('start-quiz', sessionCode);
            };
            
            console.log('Для принудительного запуска: forceStartQuiz()');
        </script>
    </body>
    </html>
    `);
});

// ========== SOCKET.IO HANDLERS ==========

io.on('connection', (socket) => {
    console.log('🔌 Новое подключение:', socket.id);

    socket.on('teacher-join', (sessionCode) => {
        const session = activeSessions.get(sessionCode);
        if (session) {
            session.teacher = socket.id;
            socket.join(sessionCode);
            socket.sessionCode = sessionCode;
            console.log(`👨‍🏫 Учитель присоединился к сессии: ${sessionCode}`);
            
            updateLeaderboard(session);
            
            const students = Array.from(session.students.values());
            students.forEach(student => {
                socket.emit('student-joined', {
                    student: student,
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
            socket.join(sessionCode);
            socket.sessionCode = sessionCode;
            socket.studentId = studentId;
            
            io.to(sessionCode).emit('student-joined', {
                student: student,
                totalStudents: session.students.size
            });
            
            updateLeaderboard(session);
            console.log(`👨‍🎓 Студент присоединился: ${studentName} к сессии: ${sessionCode}`);
        }
    });

    socket.on('start-quiz', (sessionCode) => {
        const session = activeSessions.get(sessionCode);
        if (session && session.teacher === socket.id) {
            startQuizViaConsole(session);
        }
    });

    socket.on('next-question', (sessionCode) => {
        const session = activeSessions.get(sessionCode);
        if (session && session.teacher === socket.id) {
            const nextQuestionIndex = session.currentQuestion + 1;
            if (nextQuestionIndex < session.quiz.questions.length) {
                startQuestion(session, nextQuestionIndex);
            } else {
                endQuiz(session);
            }
        }
    });

    socket.on('end-quiz', (sessionCode) => {
        const session = activeSessions.get(sessionCode);
        if (session && session.teacher === socket.id) {
            endQuiz(session);
        }
    });

    socket.on('student-answer', (data) => {
        const { sessionCode, questionIndex, answerIndex } = data;
        const session = activeSessions.get(sessionCode);
        
        if (session && session.status === 'active' && session.currentQuestion === questionIndex) {
            const studentId = socket.studentId;
            
            if (!session.answers.has(questionIndex)) {
                session.answers.set(questionIndex, new Map());
            }
            session.answers.get(questionIndex).set(studentId, answerIndex);
            
            const isCorrect = answerIndex === 0;
            
            if (isCorrect) {
                const currentScore = session.scores.get(studentId) || 0;
                session.scores.set(studentId, currentScore + 10);
                updateLeaderboard(session);
            }
            
            sendAnswerStats(session, questionIndex);
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
                updateLeaderboard(session);
            }
        } else if (socket.sessionCode) {
            const session = activeSessions.get(socket.sessionCode);
            if (session && session.teacher === socket.id) {
                console.log(`👨‍🏫 Учитель отключился от сессии: ${socket.sessionCode}`);
                session.teacher = null;
            }
        }
        console.log('🔌 Отключился:', socket.id);
    });
});

// Запускаем сервер
server.listen(PORT, HOST, () => {
    console.log('🎯 ====================================');
    console.log('🎯 Quiz Master Platform запущена!');
    console.log('🎯 ====================================');
    console.log(`📁 База данных: ${DB_FILE}`);
    console.log(`🌍 Публичный URL: https://${process.env.RENDER_EXTERNAL_URL || 'localhost:' + PORT}`);
    console.log(`🚀 Сервер слушает порт: ${PORT}`);
    console.log('🎯 ====================================\n');
    
    // Показываем состояние БД при старте
    debugDatabase();
});
