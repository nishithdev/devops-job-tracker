// Welcome page script
let currentSlide = 1;
const totalSlides = 4;

function updateProgress() {
  const progress = (currentSlide / totalSlides) * 100;
  document.getElementById('progress-fill').style.width = `${progress}%`;
}

function showSlide(slideNumber) {
  // Hide all slides
  document.querySelectorAll('.slide').forEach(slide => {
    slide.classList.remove('active');
  });
  
  // Show current slide
  const targetSlide = document.querySelector(`[data-slide="${slideNumber}"]`);
  if (targetSlide) {
    targetSlide.classList.add('active');
    currentSlide = slideNumber;
    updateProgress();
  }
}

function nextSlide() {
  if (currentSlide < totalSlides) {
    showSlide(currentSlide + 1);
  }
}

function previousSlide() {
  if (currentSlide > 1) {
    showSlide(currentSlide - 1);
  }
}

function finishWelcome() {
  // Mark welcome as completed
  chrome.storage.local.set({ 
    welcomeCompleted: true,
    lastVersion: chrome.runtime.getManifest().version
  }, () => {
    // Open LinkedIn feed in new tab
    chrome.tabs.create({ url: 'https://www.linkedin.com/feed/' });
    // Close welcome page
    window.close();
  });
}

function skipTutorial() {
  if (confirm('Are you sure you want to skip the tutorial? You can always revisit it from the Settings page.')) {
    finishWelcome();
  }
}

// Event listeners for Slide 1
document.getElementById('next-btn-1')?.addEventListener('click', nextSlide);
document.getElementById('skip-btn')?.addEventListener('click', skipTutorial);

// Event listeners for Slide 2
document.getElementById('next-btn-2')?.addEventListener('click', nextSlide);
document.getElementById('back-btn-2')?.addEventListener('click', previousSlide);

// Event listeners for Slide 3
document.getElementById('next-btn-3')?.addEventListener('click', nextSlide);
document.getElementById('back-btn-3')?.addEventListener('click', previousSlide);

// Event listeners for Slide 4
document.getElementById('finish-btn')?.addEventListener('click', finishWelcome);
document.getElementById('back-btn-4')?.addEventListener('click', previousSlide);

// Initialize
updateProgress();
