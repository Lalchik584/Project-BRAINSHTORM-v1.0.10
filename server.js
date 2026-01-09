const express = require('express');
const http = require('http');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const socketIo = require('socket.io');
const qr = require('qr-image');

const app = express();
const server = http.createServer(app);

// Автоматически определяем порт для хостинга
const PORT = process.env.PORT || 5000;

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const DB_FILE = 'quizzes.json';

// Базы данных
let quizzes = [];
let usedCodes = new Set();
let activeSessions = new Map();

// Загрузка квизов из файла
function loadQuizzesFromFile() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            quizzes = JSON.parse(data);
            quizzes.forEach(quiz => usedCodes.add(quiz.article));
            console.log(`✅ Загружено ${quizzes.length} квизов`);
        }
    } catch (error) {
        console.error('❌ Ошибка загрузки квизов:', error);
        quizzes = [];
    }
}

function saveQuizzesToFile() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(quizzes, null, 2));
    } catch (error) {
        console.error('❌ Ошибка сохранения квизов:', error);
    }
}

function generateSessionCode() {
    let code;
    do {
        code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (activeSessions.has(code));
    return code;
}

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ КВИЗА ==========

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
    
    // Перемешиваем варианты, но запоминаем индекс правильного ответа
    const correctAnswerIndex = 0;
    for (let i = options.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [options[i], options[j]] = [options[j], options[i]];
    }
    
    const timeLimit = 30; // 30 секунд на вопрос
    
    // Отправляем вопрос только студентам
    if (session.teacher) {
        io.to(session.code).except(session.teacher).emit('question-started', {
            questionIndex: questionIndex,
            question: {
                question: question.question,
                options: options
            },
            timeLimit: timeLimit
        });
        
        // Отправляем информацию о вопросе учителю
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
        
        // Отправляем обновление времени
        if (session.teacher) {
            io.to(session.code).except(session.teacher).emit('timer-update', { timeLeft: timeLeft });
            io.to(session.teacher).emit('timer-update', { timeLeft: timeLeft });
        } else {
            io.to(session.code).emit('timer-update', { timeLeft: timeLeft });
        }
        
        // Отправляем статистику ответов учителю
        sendAnswerStats(session, questionIndex);
        
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            endQuestion(session, questionIndex);
        }
    }, 1000);
    
    // Сохраняем ID таймера для возможности досрочного завершения
    session.currentTimer = timerInterval;
    
    console.log(`✅ Вопрос ${questionIndex} отправлен`);
}

// Функция завершения вопроса
function endQuestion(session, questionIndex) {
    console.log(`⏰ Завершаем вопрос ${questionIndex}`);
    
    const question = session.quiz.questions[questionIndex];
    
    // Останавливаем таймер
    if (session.currentTimer) {
        clearInterval(session.currentTimer);
        session.currentTimer = null;
    }
    
    // Отправляем результаты
    if (session.teacher) {
        io.to(session.code).except(session.teacher).emit('question-ended', {
            questionIndex: questionIndex,
            correctAnswer: question.correctAnswer,
            totalCorrect: Array.from(session.answers.get(questionIndex)?.values() || []).filter(answer => answer === 0).length
        });
        
        io.to(session.teacher).emit('question-ended', {
            questionIndex: questionIndex,
            correctAnswer: question.correctAnswer,
            totalCorrect: Array.from(session.answers.get(questionIndex)?.values() || []).filter(answer => answer === 0).length
        });
    } else {
        io.to(session.code).emit('question-ended', {
            questionIndex: questionIndex,
            correctAnswer: question.correctAnswer,
            totalCorrect: Array.from(session.answers.get(questionIndex)?.values() || []).filter(answer => answer === 0).length
        });
    }
    
    console.log(`❓ Вопрос ${questionIndex + 1} завершен в сессии: ${session.code}`);
    
    // Автоматически переходим к следующему вопросу через 5 секунд
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
    
    // Формируем финальные результаты
    const finalResults = Array.from(session.scores.entries())
        .map(([studentId, score]) => ({
            studentId,
            score,
            name: session.students.get(studentId)?.name
        }))
        .sort((a, b) => b.score - a.score);
    
    // Отправляем финальные результаты всем
    io.to(session.code).emit('quiz-ended', { finalResults: finalResults });
    
    console.log(`🏁 Квиз завершен в сессии: ${session.code}`);
}

// Функция отправки статистики ответов
function sendAnswerStats(session, questionIndex) {
    const answers = session.answers.get(questionIndex);
    const answersReceived = answers ? answers.size : 0;
    const correctAnswers = answers ? Array.from(answers.values()).filter(answer => answer === 0).length : 0;
    
    // Отправляем статистику только учителю
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
    
    // Отправляем лидерборд только учителю
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
    
    // Сбрасываем scores для новой игры
    session.scores.clear();
    session.students.forEach((student, studentId) => {
        session.scores.set(studentId, 0);
    });
    
    session.answers.clear();
    
    // Отправляем начало квиза всем
    io.to(session.code).emit('quiz-started');
    console.log(`✅ Квиз "${session.quiz.title}" начат в сессии: ${session.code}`);
    
    // Автоматически начинаем первый вопрос через 3 секунды
    setTimeout(() => {
        startQuestion(session, 0);
    }, 3000);
}

// Консольные команды
function setupConsoleCommands() {
    console.log('\n📟 Доступные консольные команды:');
    console.log('  startquiz <sessionCode> - Запустить квиз в указанной сессии');
    console.log('  listsessions - Показать все активные сессии');
    console.log('  endquiz <sessionCode> - Завершить квиз');
    console.log('  nextquestion <sessionCode> - Перейти к следующему вопросу\n');
    
    process.stdin.on('data', (data) => {
        const input = data.toString().trim();
        const parts = input.split(' ');
        const command = parts[0];
        const sessionCode = parts[1];
        
        switch(command) {
            case 'startquiz':
                if (!sessionCode) {
                    console.log('❌ Укажите код сессии: startquiz 123456');
                    return;
                }
                const session = activeSessions.get(sessionCode);
                if (!session) {
                    console.log(`❌ Сессия ${sessionCode} не найдена`);
                    return;
                }
                console.log(`🚀 Запускаю квиз в сессии ${sessionCode}...`);
                startQuizViaConsole(session);
                break;
                
            case 'listsessions':
                console.log('📋 Активные сессии:');
                if (activeSessions.size === 0) {
                    console.log('   Нет активных сессий');
                } else {
                    activeSessions.forEach((session, code) => {
                        console.log(`   ${code}: ${session.quiz.title} (${session.students.size} студентов, статус: ${session.status})`);
                    });
                }
                break;
                
            case 'endquiz':
                if (!sessionCode) {
                    console.log('❌ Укажите код сессии: endquiz 123456');
                    return;
                }
                const sessionToEnd = activeSessions.get(sessionCode);
                if (!sessionToEnd) {
                    console.log(`❌ Сессия ${sessionCode} не найдена`);
                    return;
                }
                endQuiz(sessionToEnd);
                console.log(`✅ Квиз в сессии ${sessionCode} завершен`);
                break;
                
            case 'nextquestion':
                if (!sessionCode) {
                    console.log('❌ Укажите код сессии: nextquestion 123456');
                    return;
                }
                const sessionForNext = activeSessions.get(sessionCode);
                if (!sessionForNext) {
                    console.log(`❌ Сессия ${sessionCode} не найдена`);
                    return;
                }
                const nextIndex = sessionForNext.currentQuestion + 1;
                if (nextIndex < sessionForNext.quiz.questions.length) {
                    startQuestion(sessionForNext, nextIndex);
                    console.log(`✅ Переход к вопросу ${nextIndex + 1} в сессии ${sessionCode}`);
                } else {
                    console.log(`❌ Это был последний вопрос в сессии ${sessionCode}`);
                }
                break;
                
            default:
                console.log(`❌ Неизвестная команда: ${command}`);
                console.log('Доступные команды: startquiz, listsessions, endquiz, nextquestion');
        }
    });
}

loadQuizzesFromFile();

// ========== EXPRESS ROUTES ==========

// Middleware
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
        <a href="/teacher.html">👨‍🏫 Teacher Panel</a> | 
        <a href="/student.html">👨‍🎓 Student Access</a>
    </body>
    </html>
    `);
});

// API для создания квиза
app.post('/api/quizzes', (req, res) => {
    try {
        const { title, questions } = req.body;
        
        if (!title || !questions || questions.length === 0) {
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

        quizzes.push(newQuiz);
        usedCodes.add(newQuiz.article);
        saveQuizzesToFile();
        
        res.json({ success: true, quiz: newQuiz });
        
    } catch (error) {
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// API для поиска квизов - ИСПРАВЛЕНО!
app.get('/api/quizzes/search', (req, res) => {
    try {
        const { query } = req.query;
        
        if (!query || query.trim() === '') {
            return res.json({ success: true, results: [] });
        }
        
        const searchTerm = query.trim().toLowerCase();
        
        // Ищем по названию или артикулу
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
        const quiz = quizzes.find(q => q.article === quizArticle);
        
        if (!quiz) {
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
    const url = `${req.protocol}://${req.get('host')}/student.html?session=${sessionCode}`;
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
                    body { font-family: Arial; margin: 40px; text-align: center; }
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
                <p>1. Go to: <code>http://${req.get('host')}/student.html</code></p>
                <p>2. Enter session code: <strong>${sessionCode}</strong></p>
                <p>3. Or scan QR code below:</p>
                <img src="/qr/${sessionCode}" alt="QR Code" style="border: 1px solid #ddd; padding: 10px; background: white;">
            </div>
        </div>
        
        <script src="/socket.io/socket.io.js"></script>
        <script>
            const socket = io();
            const sessionCode = '${sessionCode}';
            const startBtn = document.getElementById('startBtn');
            const resultDiv = document.getElementById('result');
            
            // Подключаем учителя
            socket.emit('teacher-join', sessionCode);
            
            function startQuiz() {
                startBtn.disabled = true;
                startBtn.textContent = 'Starting...';
                resultDiv.innerHTML = '<p>Starting quiz...</p>';
                
                socket.emit('start-quiz', sessionCode);
                
                // Таймаут для ошибок
                setTimeout(() => {
                    if (startBtn.textContent === 'Starting...') {
                        resultDiv.innerHTML = '<p style="color: orange;">⚠️ Taking longer than expected...</p>';
                    }
                }, 3000);
            }
            
            function nextQuestion() {
                socket.emit('next-question', sessionCode);
                resultDiv.innerHTML = '<p>Moving to next question...</p>';
            }
            
            function endQuiz() {
                socket.emit('end-quiz', sessionCode);
                resultDiv.innerHTML = '<p>Ending quiz...</p>';
            }
            
            // Обработчик успешного старта
            socket.on('quiz-started', () => {
                startBtn.textContent = '✅ Quiz Started';
                startBtn.className = 'btn btn-started';
                startBtn.disabled = true;
                resultDiv.innerHTML = '<p style="color: green;">✅ Quiz started successfully!</p>';
                
                // Показываем кнопки управления
                const nextBtn = document.getElementById('nextBtn');
                const endBtn = document.getElementById('endBtn');
                if (nextBtn) nextBtn.style.display = 'inline-block';
                if (endBtn) endBtn.style.display = 'inline-block';
                
                // Обновляем статус
                const statusEl = document.querySelector('.status');
                statusEl.innerHTML = 'Status: <strong>ACTIVE</strong>';
                statusEl.className = 'status status-active';
            });
            
            // Обработчик ошибок
            socket.on('error', (data) => {
                startBtn.disabled = false;
                startBtn.textContent = '🚀 Start Quiz (Retry)';
                resultDiv.innerHTML = '<p style="color: red;">❌ Error: ' + (data.message || 'Unknown error') + '</p>';
                console.error('Quiz start error:', data);
            });
            
            // Обработчик студентов
            socket.on('student-joined', (data) => {
                console.log('Student joined:', data.student.name);
                
                // Удаляем сообщение "No students"
                const noStudents = document.getElementById('no-students');
                if (noStudents) noStudents.remove();
                
                // Добавляем студента в список
                const student = data.student;
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
                
                // Обновляем счетчик
                document.getElementById('students-count').textContent = data.totalStudents;
            });
            
            socket.on('student-left', (data) => {
                const element = document.getElementById('student-' + data.studentId);
                if (element) {
                    element.remove();
                }
                document.getElementById('students-count').textContent = data.totalStudents;
                
                // Если студентов не осталось, показываем сообщение
                if (data.totalStudents === 0) {
                    const container = document.getElementById('students-container');
                    container.innerHTML = '<p id="no-students">No students connected yet...</p>';
                }
            });
            
            // Обработчик завершения квиза
            socket.on('quiz-ended', () => {
                resultDiv.innerHTML = '<p style="color: green;">✅ Quiz completed successfully!</p>';
                const statusEl = document.querySelector('.status');
                statusEl.innerHTML = 'Status: <strong>COMPLETED</strong>';
                statusEl.className = 'status status-completed';
                
                // Скрываем кнопки управления
                const nextBtn = document.getElementById('nextBtn');
                const endBtn = document.getElementById('endBtn');
                if (nextBtn) nextBtn.style.display = 'none';
                if (endBtn) endBtn.style.display = 'none';
            });
            
            // Функция для принудительного запуска через консоль
            window.forceStartQuiz = function() {
                console.log('Force starting quiz via console...');
                socket.emit('start-quiz', sessionCode);
            };
            
            console.log('Для принудительного запуска введите: forceStartQuiz()');
        </script>
    </body>
    </html>
    `);
});

// ========== SOCKET.IO HANDLERS ==========

io.on('connection', (socket) => {
    console.log('🔌 Новое подключение:', socket.id);

    // Учитель присоединяется к сессии
    socket.on('teacher-join', (sessionCode) => {
        const session = activeSessions.get(sessionCode);
        if (session) {
            session.teacher = socket.id;
            socket.join(sessionCode);
            socket.sessionCode = sessionCode;
            console.log(`👨‍🏫 Учитель присоединился к сессии: ${sessionCode} (socket: ${socket.id})`);
            
            // Отправляем текущее состояние учителю
            updateLeaderboard(session);
            
            // Отправляем текущих студентов учителю
            const students = Array.from(session.students.values());
            students.forEach(student => {
                socket.emit('student-joined', {
                    student: student,
                    totalStudents: session.students.size
                });
            });
        } else {
            console.error(`❌ Сессия ${sessionCode} не найдена для teacher-join`);
        }
    });

    // Студент присоединяется к сессии
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
            
            // Уведомляем всех о новом студенте (включая учителя)
            io.to(sessionCode).emit('student-joined', {
                student: student,
                totalStudents: session.students.size
            });
            
            // Обновляем лидерборд для учителя
            updateLeaderboard(session);
            
            console.log(`👨‍🎓 Студент присоединился: ${studentName} к сессии: ${sessionCode}`);
        } else {
            console.error(`❌ Сессия не найдена: ${sessionCode}`);
            socket.emit('error', { message: 'Session not found' });
        }
    });

    // Начало квиза
    socket.on('start-quiz', (sessionCode) => {
        console.log(`🚀 Получен запрос на начало квиза для сессии: ${sessionCode} от socket: ${socket.id}`);
        const session = activeSessions.get(sessionCode);
        
        if (session) {
            console.log(`✅ Сессия найдена: ${sessionCode}`);
            console.log(`   Статус сессии: ${session.status}`);
            console.log(`   ID учителя: ${session.teacher}`);
            console.log(`   ID текущего сокета: ${socket.id}`);
            console.log(`   Студентов подключено: ${session.students.size}`);
            
            // Проверяем, является ли этот сокет учителем
            if (session.teacher === socket.id) {
                console.log(`✅ Сокет авторизован как учитель`);
                
                if (session.status === 'active') {
                    console.log('⚠️ Квиз уже запущен');
                    socket.emit('error', { message: 'Quiz is already active' });
                    return;
                }
                
                startQuizViaConsole(session);
                
            } else {
                console.error(`❌ Сокет не авторизован как учитель`);
                console.log(`   Ожидаемый ID учителя: ${session.teacher}`);
                console.log(`   ID текущего сокета: ${socket.id}`);
                
                // Проверяем, может это учитель, который переподключился?
                if (!session.teacher && session.students.size === 0) {
                    // Если нет учителя и нет студентов, назначаем этого сокета учителем
                    console.log(`⚠️ Назначаю сокет ${socket.id} учителем`);
                    session.teacher = socket.id;
                    startQuizViaConsole(session);
                } else {
                    socket.emit('error', { 
                        message: 'Not authorized to start quiz',
                        teacherId: session.teacher,
                        yourId: socket.id
                    });
                }
            }
        } else {
            console.error(`❌ Сессия ${sessionCode} не найдена`);
            socket.emit('error', { message: `Session ${sessionCode} not found` });
        }
    });

    // Следующий вопрос
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

    // Завершение квиза
    socket.on('end-quiz', (sessionCode) => {
        const session = activeSessions.get(sessionCode);
        if (session && session.teacher === socket.id) {
            endQuiz(session);
        }
    });

    // Ответ студента
    socket.on('student-answer', (data) => {
        const { sessionCode, questionIndex, answerIndex } = data;
        const session = activeSessions.get(sessionCode);
        
        if (session && session.status === 'active' && session.currentQuestion === questionIndex) {
            const studentId = socket.studentId;
            const question = session.quiz.questions[questionIndex];
            
            // Сохраняем ответ
            if (!session.answers.has(questionIndex)) {
                session.answers.set(questionIndex, new Map());
            }
            session.answers.get(questionIndex).set(studentId, answerIndex);
            
            // Проверяем правильность ответа
            const isCorrect = answerIndex === 0; // Правильный ответ всегда первый (index 0)
            
            if (isCorrect) {
                // Начисляем очки
                const currentScore = session.scores.get(studentId) || 0;
                session.scores.set(studentId, currentScore + 10);
                
                // Обновляем таблицу лидеров (только для учителя)
                updateLeaderboard(session);
            }
            
            // Отправляем статистику ответов (только учителю)
            sendAnswerStats(session, questionIndex);
        }
    });

    // Обработка отключения
    socket.on('disconnect', () => {
        if (socket.sessionCode && socket.studentId) {
            const session = activeSessions.get(socket.sessionCode);
            if (session) {
                session.students.delete(socket.studentId);
                io.to(socket.sessionCode).emit('student-left', {
                    studentId: socket.studentId,
                    totalStudents: session.students.size
                });
                
                // Обновляем лидерборд для учителя
                updateLeaderboard(session);
            }
        } else if (socket.sessionCode) {
            // Возможно, это отключился учитель
            const session = activeSessions.get(socket.sessionCode);
            if (session && session.teacher === socket.id) {
                console.log(`👨‍🏫 Учитель отключился от сессии: ${socket.sessionCode}`);
                session.teacher = null;
            }
        }
        console.log('🔌 Отключился:', socket.id);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎯 Сервер запущен: http://localhost:${PORT}`);
    console.log(`🌐 Доступен по адресу: ${process.env.RAILWAY_PUBLIC_DOMAIN || `http://localhost:${PORT}`}`);
    setupConsoleCommands();
});