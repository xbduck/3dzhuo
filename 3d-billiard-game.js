// 3D桌球游戏主逻辑 - 支持多人在线对战
// 技术栈: Three.js + Cannon.js + Socket.io

class BilliardGame3D {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.world = null;
        this.balls = [];
        this.table = null;
        this.pockets = [];
        this.socket = null;
        this.playerId = null;
        this.gameId = null;
        this.isMyTurn = false;
        this.cueBall = null;
        this.score = { player1: 0, player2: 0 };
        this.isDragging = false;
        this.dragStart = { x: 0, y: 0 };
        this.dragEnd = { x: 0, y: 0 };
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.user = {
            name: '',
            isGuest: false
        };

        this.init();
    }

    init() {
        this.initThree();
        this.initPhysics();
        this.initSocket();
        this.initUI();
        this.createTable();
        this.createBalls();
        this.createLighting();
        this.animate();
    }

    initThree() {
        // 创建场景
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x1a1a2e);
        this.scene.fog = new THREE.Fog(0x1a1a2e, 10, 50);

        // 创建相机
        this.camera = new THREE.PerspectiveCamera(
            60,
            window.innerWidth / window.innerHeight,
            0.1,
            1000
        );
        this.camera.position.set(0, 8, 12);
        this.camera.lookAt(0, 0, 0);

        // 创建渲染器
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.outputEncoding = THREE.sRGBEncoding;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.2;
        document.getElementById('game-container').appendChild(this.renderer.domElement);

        // 窗口大小调整
        window.addEventListener('resize', () => this.onWindowResize());
    }

    initPhysics() {
        // 创建物理世界
        this.world = new CANNON.World();
        this.world.gravity.set(0, -9.82, 0);
        this.world.broadphase = new CANNON.SAPBroadphase(this.world);
        this.world.solver.iterations = 10;

        // 材质
        const defaultMaterial = new CANNON.Material('default');
        const defaultContactMaterial = new CANNON.ContactMaterial(
            defaultMaterial,
            defaultMaterial,
            {
                friction: 0.3,
                restitution: 0.7
            }
        );
        this.world.addContactMaterial(defaultContactMaterial);
    }

    initSocket() {
        // 连接到服务器（需要配置服务器地址）
        this.socket = io('http://192.168.62.57:3000');

        // this.socket = {
        //     emit: (event, data) => {
        //         console.log('发送消息:', event, data);
        //         // 模拟服务器响应
        //         if (event === 'login') {
        //             this.playerId = 'player_' + Date.now();
        //             this.showLoginSuccess();
        //         } else if (event === 'find_match') {
        //             this.showMatching();
        //             setTimeout(() => {
        //                 this.showMatchFound();
        //             }, 3000);
        //         } else if (event === 'shoot') {
        //             console.log('发送击球数据:', data);
        //         }
        //     },
        //     on: (event, callback) => {
        //         console.log('监听事件:', event);
        //     }
        // };
        // 监听服务器事件
        this.socket.on('connect', () => {
            console.log('✅ 已连接到服务器');
        });

        this.socket.on('login_success', (data) => {
            this.playerId = data.userId;
            this.showLoginSuccess();
        });

        this.socket.on('match_found', (data) => {
            this.showMatchFound(data);
        });

        this.socket.on('opponent_shoot', (data) => {
            this.handleOpponentShoot(data);
        });

        this.socket.on('score_updated', (data) => {
            this.updateScore(data);
        });
    }

    initUI() {
        // 登录按钮
        document.getElementById('login-submit').addEventListener('click', () => {
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            
            if (!username) {
                alert('请输入用户名');
                return;
            }

            this.user.name = username;
            this.socket.emit('login', { username, password });
        });

        // 游客登录
        document.getElementById('guest-login').addEventListener('click', () => {
            this.user.name = '游客' + Math.floor(Math.random() * 1000);
            this.user.isGuest = true;
            // 直接登录成功，不通过Socket
            this.showLoginSuccess();
            // this.socket.emit('login', { 
            //     username: this.user.name, 
            //     isGuest: true 
            // });
        });

        // 匹配按钮
        document.getElementById('find-match').addEventListener('click', () => {
            this.socket.emit('find_match');
        });

        // 退出按钮
        document.getElementById('quit-game').addEventListener('click', () => {
            if (confirm('确定要退出游戏吗？')) {
                location.reload();
            }
        });

        // 聊天按钮
        document.getElementById('toggle-chat').addEventListener('click', () => {
            const chatWindow = document.getElementById('chat-window');
            chatWindow.style.display = chatWindow.style.display === 'none' ? 'block' : 'none';
        });

        // 聊天输入
        document.getElementById('chat-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const message = e.target.value.trim();
                if (message) {
                    this.sendChatMessage(message);
                    e.target.value = '';
                }
            }
        });

        // 触摸和鼠标事件
        this.renderer.domElement.addEventListener('mousedown', (e) => this.handleInputStart(e));
        this.renderer.domElement.addEventListener('mousemove', (e) => this.handleInputMove(e));
        this.renderer.domElement.addEventListener('mouseup', () => this.handleInputEnd());
        this.renderer.domElement.addEventListener('touchstart', (e) => this.handleTouchStart(e));
        this.renderer.domElement.addEventListener('touchmove', (e) => this.handleTouchMove(e));
        this.renderer.domElement.addEventListener('touchend', () => this.handleInputEnd());
    }

    createTable() {
        // 桌面材质
        const tableMaterial = new THREE.MeshStandardMaterial({
            color: 0x1a6b3a,
            roughness: 0.8,
            metalness: 0.1
        });

        // 桌面几何体
        const tableGeometry = new THREE.BoxGeometry(10, 0.5, 18);
        this.table = new THREE.Mesh(tableGeometry, tableMaterial);
        this.table.position.y = -0.25;
        this.table.receiveShadow = true;
        this.scene.add(this.table);

        // 边框材质
        const railMaterial = new THREE.MeshStandardMaterial({
            color: 0x4a2c0a,
            roughness: 0.6,
            metalness: 0.2
        });

        // 创建边框
        const railWidth = 1;
        const railHeight = 1;
        const railLength = 20;

        // 长边框
        const railGeometry = new THREE.BoxGeometry(railWidth, railHeight, railLength);
        
        const leftRail = new THREE.Mesh(railGeometry, railMaterial);
        leftRail.position.set(-5.5, 0.5, 0);
        leftRail.castShadow = true;
        leftRail.receiveShadow = true;
        this.scene.add(leftRail);

        const rightRail = new THREE.Mesh(railGeometry, railMaterial);
        rightRail.position.set(5.5, 0.5, 0);
        rightRail.castShadow = true;
        rightRail.receiveShadow = true;
        this.scene.add(rightRail);

        // 短边框
        const shortRailGeometry = new THREE.BoxGeometry(12, railHeight, railWidth);
        
        const topRail = new THREE.Mesh(shortRailGeometry, railMaterial);
        topRail.position.set(0, 0.5, -9.5);
        topRail.castShadow = true;
        topRail.receiveShadow = true;
        this.scene.add(topRail);

        const bottomRail = new THREE.Mesh(shortRailGeometry, railMaterial);
        bottomRail.position.set(0, 0.5, 9.5);
        bottomRail.castShadow = true;
        bottomRail.receiveShadow = true;
        this.scene.add(bottomRail);

        // 创建物理边框
        this.createPhysicsRails();

        // 创建球袋
        this.createPockets();
    }

    createPhysicsRails() {
        const railMaterial = new CANNON.Material('rail');
        const railShape = new CANNON.Box(new CANNON.Vec3(1, 1, 10));
        
        // 创建四个角的物理墙
        const wallPositions = [
            { x: -5.5, z: 0 },    // 左
            { x: 5.5, z: 0 },     // 右
            { x: 0, z: -9.5 },    // 前
            { x: 0, z: 9.5 }      // 后
        ];

        wallPositions.forEach(pos => {
            const wallBody = new CANNON.Body({ mass: 0 });
            wallBody.addShape(railShape);
            wallBody.position.set(pos.x, 0.5, pos.z);
            this.world.addBody(wallBody);
        });
    }

    createPockets() {
        const pocketPositions = [
            { x: -4.5, z: -8.5 },
            { x: 4.5, z: -8.5 },
            { x: -4.5, z: 8.5 },
            { x: 4.5, z: 8.5 },
            { x: 0, z: -9 },
            { x: 0, z: 9 }
        ];

        const pocketGeometry = new THREE.CylinderGeometry(0.4, 0.4, 0.6, 32);
        const pocketMaterial = new THREE.MeshStandardMaterial({ color: 0x000000 });

        pocketPositions.forEach(pos => {
            const pocket = new THREE.Mesh(pocketGeometry, pocketMaterial);
            pocket.position.set(pos.x, 0.3, pos.z);
            this.scene.add(pocket);
            
            this.pockets.push({
                position: pos,
                radius: 0.4
            });
        });
    }

    createBalls() {
        const ballGeometry = new THREE.SphereGeometry(0.25, 32, 32);
        const ballShape = new CANNON.Sphere(0.25);
        const ballMaterial = new CANNON.Material('ball');

        // 白球
        const whiteBallMaterial = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.2,
            metalness: 0.1
        });

        const whiteBallMesh = new THREE.Mesh(ballGeometry, whiteBallMaterial);
        whiteBallMesh.castShadow = true;
        whiteBallMesh.receiveShadow = true;
        whiteBallMesh.position.set(0, 0.25, 6);
        this.scene.add(whiteBallMesh);

        const whiteBallBody = new CANNON.Body({
            mass: 0.17,
            position: new CANNON.Vec3(0, 0.25, 6),
            material: ballMaterial
        });
        whiteBallBody.addShape(ballShape);
        whiteBallBody.linearDamping = 0.5;
        whiteBallBody.angularDamping = 0.5;
        this.world.addBody(whiteBallBody);

        this.cueBall = {
            mesh: whiteBallMesh,
            body: whiteBallBody,
            isCueBall: true,
            active: true
        };
        this.balls.push(this.cueBall);

        // 彩球
        const colors = [
            0xffff00, 0x0000ff, 0xff0000, 0x800080, 0xffa500, 
            0x008000, 0x800000, 0x000000, 0xffff00, 0x0000ff,
            0xff0000, 0x800080, 0xffa500, 0x008000, 0x800000
        ];

        const startZ = -5;
        const row = 0;
        const spacing = 0.52;

        colors.forEach((color, index) => {
            const ballMaterial = new THREE.MeshStandardMaterial({
                color: color,
                roughness: 0.2,
                metalness: 0.1
            });

            const ballMesh = new THREE.Mesh(ballGeometry, ballMaterial);
            ballMesh.castShadow = true;
            ballMesh.receiveShadow = true;

            // 计算位置（三角排列）
            const rowIndex = Math.floor(index / 5);
            const colIndex = index % 5;
            const x = (colIndex - 2) * spacing;
            const z = startZ + rowIndex * spacing * 0.866;

            ballMesh.position.set(x, 0.25, z);
            this.scene.add(ballMesh);

            const ballBody = new CANNON.Body({
                mass: 0.17,
                position: new CANNON.Vec3(x, 0.25, z),
                material: ballMaterial
            });
            ballBody.addShape(ballShape);
            ballBody.linearDamping = 0.5;
            ballBody.angularDamping = 0.5;
            this.world.addBody(ballBody);

            this.balls.push({
                mesh: ballMesh,
                body: ballBody,
                color: color,
                active: true
            });
        });
    }

    createLighting() {
        // 环境光
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
        this.scene.add(ambientLight);

        // 主光源
        const mainLight = new THREE.DirectionalLight(0xffffff, 1);
        mainLight.position.set(5, 10, 5);
        mainLight.castShadow = true;
        mainLight.shadow.mapSize.width = 2048;
        mainLight.shadow.mapSize.height = 2048;
        mainLight.shadow.camera.near = 0.5;
        mainLight.shadow.camera.far = 50;
        this.scene.add(mainLight);

        // 补光
        const fillLight = new THREE.DirectionalLight(0x667eea, 0.3);
        fillLight.position.set(-5, 5, -5);
        this.scene.add(fillLight);

        // 球桌照明
        const tableLight = new THREE.PointLight(0xffffff, 0.8, 20);
        tableLight.position.set(0, 6, 0);
        tableLight.castShadow = true;
        this.scene.add(tableLight);
    }

    handleInputStart(event) {
        if (!this.isMyTurn || !this.cueBall || !this.cueBall.active) return;

        const clientX = event.clientX || event.touches[0].clientX;
        const clientY = event.clientY || event.touches[0].clientY;

        this.mouse.x = (clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(clientY / window.innerHeight) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObject(this.cueBall.mesh);

        if (intersects.length > 0) {
            this.isDragging = true;
            this.dragStart = { x: clientX, y: clientY };
        }
    }

    handleInputMove(event) {
        if (!this.isDragging) return;

        const clientX = event.clientX || event.touches[0].clientX;
        const clientY = event.clientY || event.touches[0].clientY;

        this.dragEnd = { x: clientX, y: clientY };

        // 更新力度条
        const dx = this.dragStart.x - clientX;
        const dy = this.dragStart.y - clientY;
        const power = Math.min(Math.sqrt(dx * dx + dy * dy) * 0.02, 1) * 100;
        
        document.getElementById('power-bar').style.width = power + '%';
    }

    handleTouchStart(event) {
        event.preventDefault();
        this.handleInputStart(event);
    }

    handleTouchMove(event) {
        event.preventDefault();
        this.handleInputMove(event);
    }

    handleInputEnd() {
        if (!this.isDragging) return;

        const dx = this.dragStart.x - this.dragEnd.x;
        const dy = this.dragStart.y - this.dragEnd.y;
        const power = Math.min(Math.sqrt(dx * dx + dy * dy) * 0.1, 5);

        if (power > 0.1 && this.cueBall && this.cueBall.active) {
            // 计算击球方向
            const angle = Math.atan2(dy, dx);
            const impulse = new CANNON.Vec3(
                Math.cos(angle) * power,
                0,
                Math.sin(angle) * power
            );

            // 应用力到白球
            this.cueBall.body.applyImpulse(impulse, this.cueBall.body.position);

            // 发送击球数据到服务器
            this.socket.emit('shoot', {
                gameId: this.gameId,
                playerId: this.playerId,
                power: power,
                angle: angle
            });

            this.isMyTurn = false;
            this.updateGameStatus('等待对手击球');
        }

        this.isDragging = false;
        document.getElementById('power-bar').style.width = '0%';
    }

    checkPockets() {
        this.balls.forEach(ball => {
            if (!ball.active) return;

            const ballPos = ball.body.position;
            this.pockets.forEach(pocket => {
                const distance = Math.sqrt(
                    Math.pow(ballPos.x - pocket.position.x, 2) +
                    Math.pow(ballPos.z - pocket.position.z, 2)
                );

                if (distance < pocket.radius) {
                    ball.active = false;
                    this.scene.remove(ball.mesh);
                    this.world.removeBody(ball.body);

                    if (ball.isCueBall) {
                        // 白球进袋，重新放置
                        setTimeout(() => {
                            ball.body.position.set(0, 0.25, 6);
                            ball.body.velocity.set(0, 0, 0);
                            ball.body.angularVelocity.set(0, 0, 0);
                            ball.active = true;
                            this.scene.add(ball.mesh);
                            this.world.addBody(ball.body);
                        }, 1000);
                    } else {
                        // 彩球进袋，加分
                        if (this.isMyTurn) {
                            this.score.player1 += 10;
                            document.getElementById('player1-score').textContent = this.score.player1;
                        } else {
                            this.score.player2 += 10;
                            document.getElementById('player2-score').textContent = this.score.player2;
                        }

                        // 发送进球消息到服务器
                        this.socket.emit('ball_pocketed', {
                            gameId: this.gameId,
                            playerId: this.playerId,
                            score: this.score
                        });
                    }
                }
            });
        });
    }

    showLoginSuccess() {
        document.getElementById('login-screen').style.opacity = '0';
        setTimeout(() => {
            document.getElementById('login-screen').style.display = 'none';
            document.getElementById('game-ui').style.display = 'block';
        }, 500);

        document.getElementById('player1-name').textContent = this.user.name;
        document.getElementById('player1-avatar').textContent = this.user.name.charAt(0).toUpperCase();
    }

    showMatching() {
        document.getElementById('matching-screen').style.display = 'flex';
    }

    showMatchFound() {
        document.getElementById('matching-screen').style.display = 'none';
        this.gameId = 'game_' + Date.now();
        this.isMyTurn = true;
        this.updateGameStatus('你的回合，请击球');
        
        document.getElementById('player2-name').textContent = '对手';
        document.getElementById('player2-avatar').textContent = '对';
    }

    updateGameStatus(status) {
        document.getElementById('game-status-text').textContent = status;
    }

    sendChatMessage(message) {
        const chatMessages = document.getElementById('chat-messages');
        const messageDiv = document.createElement('div');
        messageDiv.className = 'chat-message';
        messageDiv.innerHTML = `<span class="name">${this.user.name}:</span> ${message}`;
        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        // 发送到服务器
        this.socket.emit('chat_message', {
            gameId: this.gameId,
            playerId: this.playerId,
            message: message
        });
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        // 更新物理世界
        this.world.step(1 / 60);

        // 同步物理到渲染
        this.balls.forEach(ball => {
            if (ball.active) {
                ball.mesh.position.copy(ball.body.position);
                ball.mesh.quaternion.copy(ball.body.quaternion);
            }
        });

        // 检查进袋
        this.checkPockets();

        // 渲染
        this.renderer.render(this.scene, this.camera);
    }
}

// 页面加载完成后启动游戏
document.addEventListener('DOMContentLoaded', () => {
    new BilliardGame3D();
});
