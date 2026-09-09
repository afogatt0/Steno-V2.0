const synth = window.speechSynthesis;
const voiceSelect = document.getElementById('voiceSelect');
const modeSelect = document.getElementById('modeSelect');

let words = [];
let voices = [];
let currentIndex = 0;
let isPlaying = false;
let wakeLock = null;
let currentWpm = 90;

// Dual System Variables
let timer = null; // Strict mode clock
let nextWordTime = 0; // Strict mode timing
let isCancelling = false; // Natural mode state guard
window.currentUtterance = null; // Garbage collection prevention

function normalizeText(text) {
    let normalized = text.replace(/(\d),(?=\d{3}(\D|$))/g, '$1');
    const symbolMap = { '$': ' dollars ', '%': ' percent ', '&': ' and ', '@': ' at ', '#': ' number ' };
    for (const [symbol, replacement] of Object.entries(symbolMap)) {
        normalized = normalized.replace(new RegExp(`\\${symbol}`, 'g'), replacement);
    }
    return normalized.trim();
}

function loadVoices() {
    voices = synth.getVoices();
    if (voices.length === 0) return;
    const englishVoices = voices.filter(v => v.lang.includes('en'));
    voiceSelect.innerHTML = englishVoices.map(v => `<option value="${v.name}">${v.name}</option>`).join('');
    const preferred = ["Microsoft David", "Google US English", "Microsoft Zira", "Samantha"];
    for (let name of preferred) {
        const found = englishVoices.find(v => v.name.includes(name));
        if (found) { voiceSelect.value = found.name; break; }
    }
}

// CRITICAL FIX: Correctly bind the function to the event listener
if (speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = loadVoices;
}
loadVoices();

function saveText() {
    localStorage.setItem('stenoText', document.getElementById('textInput').value);
}

function loadSavedText() {
    const saved = localStorage.getItem('stenoText');
    if (saved) document.getElementById('textInput').value = saved;
}

function clearAll() {
    document.getElementById('textInput').value = "";
    localStorage.removeItem('stenoText');
    reset();
    initDisplay();
}

function toggleTheme() {
    document.body.classList.toggle('night-theme');
    localStorage.setItem('stenoTheme', document.body.classList.contains('night-theme') ? 'night' : 'light');
}

function adjustSpeed(amount) {
    currentWpm += amount;
    if (currentWpm > 250) currentWpm = 250;
    if (currentWpm < 15) currentWpm = 15;
    document.getElementById('wpmVal').innerText = currentWpm;
    
    if (isPlaying) {
        routePlayback();
    }
}

function changeMode() {
    if (isPlaying) {
        routePlayback(); // Seamlessly swaps engines on the fly
    }
}

function initDisplay() {
    const textInput = document.getElementById('textInput').value;
    const display = document.getElementById('displayArea');
    const segments = textInput.split(/(\n+|[.!?;:\-—()"]|\s+)/);

    let htmlOutput = "";
    words = []; 
    let currentCharIndex = 0; 

    segments.forEach((segment) => {
        if (!segment) return;
        
        if (segment.includes('\n')) {
            htmlOutput += segment.replace(/\n/g, '<br>');
            words.push({ text: segment, type: 'newline', label: '', id: null, charStart: currentCharIndex, charEnd: currentCharIndex + segment.length });
            currentCharIndex += segment.length;
        } else if (/^\s+$/.test(segment)) {
            htmlOutput += segment;
            words.push({ text: segment, type: 'space', label: '', id: null, charStart: currentCharIndex, charEnd: currentCharIndex + segment.length });
            currentCharIndex += segment.length;
        } else {
            const isPunct = /^[.!?;:\-—()"]$/.test(segment);
            const wordIdx = words.length; 
            
            htmlOutput += `<span id="w-${wordIdx}" class="word" onclick="setIndex(${wordIdx})">${segment}</span>`;
            
            words.push({ 
                text: segment, 
                type: isPunct ? 'punctuation' : 'word', 
                label: isPunct ? '' : normalizeText(segment), 
                id: `w-${wordIdx}`,
                charStart: currentCharIndex, 
                charEnd: currentCharIndex + segment.length
            });
            
            currentCharIndex += segment.length;
        }
    });

    display.innerHTML = htmlOutput;
    document.getElementById('wordCount').innerText = words.filter(w => /[a-zA-Z0-9]/.test(w.text)).length;
}

function updateHighlight(index) {
    document.querySelectorAll('.word').forEach(el => el.classList.remove('current-word'));
    const wordObj = words[index];
    if (wordObj && wordObj.id) {
        const el = document.getElementById(wordObj.id);
        if (el) {
            el.classList.add('current-word');
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
}

/* =========================================
   ROUTING & PLAYBACK CONTROLS 
   ========================================= */

async function handlePlay() {
    if (words.length === 0) return;
    
    if (isPlaying) {
        // PAUSE Action
        isPlaying = false;
        synth.cancel();
        cancelAnimationFrame(timer);
        isCancelling = true;
        document.getElementById('mainBtn').innerText = "RESUME";
        if (wakeLock) { wakeLock.release().then(() => wakeLock = null); }
    } else {
        // PLAY Action
        isPlaying = true;
        document.getElementById('mainBtn').innerText = "PAUSE";
        isCancelling = false;
        
        if ('wakeLock' in navigator) {
            try { wakeLock = await navigator.wakeLock.request('screen'); } catch (err) {}
        }
        
        routePlayback();
    }
}

function routePlayback() {
    synth.cancel();
    cancelAnimationFrame(timer);
    isCancelling = true; 
    setTimeout(() => isCancelling = false, 50);

    if (modeSelect.value === 'strict') {
        nextWordTime = performance.now();
        playStrictLoop();
    } else {
        startNaturalSpeech(currentIndex);
    }
}

function setIndex(i) {
    currentIndex = i;
    updateHighlight(i);
    
    if (isPlaying) {
        routePlayback();
    }
}

function reset() {
    isPlaying = false;
    isCancelling = true; 
    synth.cancel();
    cancelAnimationFrame(timer);
    currentIndex = 0;
    document.getElementById('mainBtn').innerText = "PLAY";
    if (wakeLock) { wakeLock.release().then(() => wakeLock = null); }
    updateHighlight(0); 
}

/* =========================================
   MODE 1: STRICT METRONOME (WORD-BY-WORD)
   ========================================= */

function playStrictLoop() {
    if (!isPlaying || modeSelect.value !== 'strict') return;
    
    while (currentIndex < words.length && (!words[currentIndex].label || words[currentIndex].label.trim() === '')) {
        updateHighlight(currentIndex);
        currentIndex++;
    }

    if (currentIndex >= words.length) {
        reset();
        return;
    }

    const now = performance.now();
    
    if (now >= nextWordTime) {
        const wordObj = words[currentIndex];
        const msPerWord = (60 / currentWpm) * 1000;
        
        updateHighlight(currentIndex);
        synth.cancel(); 
        
        const utterance = new SpeechSynthesisUtterance(wordObj.label);
        const selectedVoice = voices.find(v => v.name === voiceSelect.value);
        if (selectedVoice) utterance.voice = selectedVoice;
        
        const labelLength = wordObj.label ? wordObj.label.length : 0;
        const lengthMultiplier = labelLength > 7 ? 1.4 : 1.0;
        utterance.rate = Math.max(1.1, (currentWpm / 70) * lengthMultiplier);
        
        synth.speak(utterance);

        currentIndex++;
        nextWordTime += msPerWord;
        
        if (now > nextWordTime + 500) {
            nextWordTime = now + msPerWord;
        }
    }
    
    timer = requestAnimationFrame(playStrictLoop);
}

/* =========================================
   MODE 2: NATURAL FLOW (SENTENCE SYNC)
   ========================================= */

function startNaturalSpeech(startIndex) {
    if (startIndex >= words.length) {
        reset();
        return;
    }

    // Skip empty spaces at the very start to find the first real character offset
    while (startIndex < words.length && (!words[startIndex].label || words[startIndex].label.trim() === '')) {
        startIndex++;
    }
    if (startIndex >= words.length) {
        reset();
        return;
    }
    
    currentIndex = startIndex;
    updateHighlight(currentIndex);

    const remainingText = document.getElementById('textInput').value.substring(words[startIndex].charStart);
    const utterance = new SpeechSynthesisUtterance(remainingText);
    
    const selectedVoice = voices.find(v => v.name === voiceSelect.value);
    if (selectedVoice) utterance.voice = selectedVoice;
    
    // Scale continuous reading speed to 180 baseline
    utterance.rate = Math.max(0.1, currentWpm / 180);
    window.currentUtterance = utterance; 

    const charOffset = words[startIndex].charStart; 

    utterance.onboundary = (event) => {
        if (event.name === 'word') {
            const absoluteIndex = event.charIndex + charOffset;
            const matchIndex = words.findIndex(w => 
                absoluteIndex >= w.charStart && absoluteIndex < w.charEnd && w.id !== null
            );
            
            if (matchIndex !== -1) {
                currentIndex = matchIndex;
                updateHighlight(matchIndex);
            }
        }
    };

    utterance.onend = () => {
        if (!isCancelling) reset();
    };

    synth.speak(utterance);
}

// Initial Boot Hooks
if (localStorage.getItem('stenoTheme') === 'night') toggleTheme();
loadSavedText();
initDisplay();

function openGoogleLens() {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile) {
        window.location.href = 'intent://lens.google.com/vsearch#Intent;scheme=https;package=com.google.android.googlequicksearchbox;end';
        setTimeout(() => { window.location.href = 'https://www.google.com'; }, 500);
    } else {
        window.open('https://www.google.com', '_blank');
    }
}