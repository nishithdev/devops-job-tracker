// Saved matches page script
// Uses shared utilities from shared/utils.js, shared/storageUtils.js, and shared/formatters.js
let allMatches = [];
let filteredMatches = [];
let displayedMatches = []; // Paginated matches
let extensionContextValid = true;
let selectedRows = new Set();
let currentPage = 1;
let pageSize = 50;
let sortColumn = 'timestamp';
let sortDirection = 'desc';

function showContextInvalidError() {
  const container = document.getElementById('matches-container');
  container.innerHTML = `
    <div class="empty-state">
      <h2 style="color:#d32f2f;">Extension Context Invalidated</h2>
      <p>The extension was reloaded or updated.</p>
      <p style="margin-top:12px;">
        <button id="btn-reload-page" style="padding:10px 20px;background:#2e7d32;color:white;border:none;border-radius:6px;cursor:pointer;font-size:14px;">
          Reload This Page
        </button>
      </p>
    </div>
  `;
  // Add event listener for reload button
  const reloadBtn = document.getElementById('btn-reload-page');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', () => window.location.reload());
  }
  // Clear intervals
  if (window.refreshInterval) clearInterval(window.refreshInterval);
}

function loadMatches() {
  if (!isContextValid()) {
    extensionContextValid = false;
    showContextInvalidError();
    return;
  }
  
  safeStorageGet(['devopsSavedMatches']).then((result) => {
    allMatches = result.devopsSavedMatches || [];
    updateStats();
    applyFilters();
  }).catch((error) => {
    console.error('Load error:', error);
    extensionContextValid = false;
    showContextInvalidError();
  });
}

function updateStats() {
  const total = allMatches.length;
  const hiring = allMatches.filter(m => m.isHiring).length;
  const devops = total - hiring;
  const duplicates = allMatches.filter(m => m.duplicateOf).length;
  
  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-hiring').textContent = hiring;
  document.getElementById('stat-devops').textContent = devops;
  document.getElementById('stat-duplicates').textContent = duplicates;
  document.getElementById('total-count').textContent = 
    `${total} ${total === 1 ? 'match' : 'matches'} saved`;
}

function applyFilters() {
  const searchText = document.getElementById('filter-input').value.toLowerCase();
  const typeFilter = document.getElementById('filter-type').value;
  const skillFilter = document.getElementById('filter-skill').value;
  const duplicateFilter = document.getElementById('filter-duplicate') ? document.getElementById('filter-duplicate').value : 'all';
  const sortBy = document.getElementById('sort-by').value;
  const pageSizeSelect = document.getElementById('page-size').value;
  
  // Update page size
  pageSize = pageSizeSelect === 'all' ? Infinity : parseInt(pageSizeSelect);
  
  // Filter by type
  filteredMatches = allMatches.filter(match => {
    if (typeFilter === 'hiring' && !match.isHiring) return false;
    if (typeFilter === 'devops' && match.isHiring) return false;
    return true;
  });
  
  // Filter by duplicate status
  if (duplicateFilter === 'duplicates-only') {
    filteredMatches = filteredMatches.filter(match => match.duplicateOf);
  } else if (duplicateFilter === 'originals-only') {
    filteredMatches = filteredMatches.filter(match => !match.duplicateOf);
  }
  
  // Filter by skill
  if (skillFilter !== 'all') {
    filteredMatches = filteredMatches.filter(match => {
      const skills = match.skills || [];
      return skills.some(skill => skill.toLowerCase() === skillFilter.toLowerCase());
    });
  }
  
  // Filter by search text
  if (searchText) {
    filteredMatches = filteredMatches.filter(match => {
      // Search in snippet, keywords, skills, and emails
      const emailText = (match.emails || []).join(' ');
      const skillsText = (match.skills || []).join(' ');
      // Support both old (single keyword) and new (multiple keywords) formats
      const keywordsText = match.devopsKeywords 
        ? match.devopsKeywords.join(' ')
        : match.devopsKeyword;
      
      return (
        match.snippet.toLowerCase().includes(searchText) ||
        keywordsText.toLowerCase().includes(searchText) ||
        (match.hiringSignal && match.hiringSignal.toLowerCase().includes(searchText)) ||
        emailText.toLowerCase().includes(searchText) ||
        skillsText.toLowerCase().includes(searchText)
      );
    });
  }
  
  // Sort
  applySorting(sortBy === 'newest' ? 'desc' : 'asc');
  
  // Reset to first page when filters change
  currentPage = 1;
  selectedRows.clear();
  updateBulkActions();
  
  renderMatches();
  updatePagination();
}

function applySorting(direction = null) {
  if (direction) sortDirection = direction;
  
  filteredMatches.sort((a, b) => {
    let aVal, bVal;
    
    switch(sortColumn) {
      case 'timestamp':
        aVal = a.timestamp;
        bVal = b.timestamp;
        break;
      case 'keyword':
        // Support both old and new formats
        aVal = (a.devopsKeywords ? a.devopsKeywords.join(', ') : a.devopsKeyword).toLowerCase();
        bVal = (b.devopsKeywords ? b.devopsKeywords.join(', ') : b.devopsKeyword).toLowerCase();
        break;
      case 'status':
        aVal = (a.status || 'new').toLowerCase();
        bVal = (b.status || 'new').toLowerCase();
        break;
      default:
        aVal = a.timestamp;
        bVal = b.timestamp;
    }
    
    if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
    return 0;
  });
}

function updatePagination() {
  const total = filteredMatches.length;
  const totalPages = Math.ceil(total / pageSize);
  const pagination = document.getElementById('pagination');
  const paginationInfo = document.getElementById('pagination-info');
  
  if (pageSize === Infinity || total === 0) {
    pagination.style.display = 'none';
    return;
  }
  
  pagination.style.display = 'flex';
  
  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, total);
  paginationInfo.textContent = `Showing ${start}-${end} of ${total}`;
  
  document.getElementById('btn-first-page').disabled = currentPage === 1;
  document.getElementById('btn-prev-page').disabled = currentPage === 1;
  document.getElementById('btn-next-page').disabled = currentPage === totalPages;
  document.getElementById('btn-last-page').disabled = currentPage === totalPages;
}

function goToPage(page) {
  const totalPages = Math.ceil(filteredMatches.length / pageSize);
  currentPage = Math.max(1, Math.min(page, totalPages));
  renderMatches();
  updatePagination();
}

function updateBulkActions() {
  const bulkActions = document.getElementById('bulk-actions');
  const bulkActionsText = document.getElementById('bulk-actions-text');
  
  if (selectedRows.size > 0) {
    bulkActions.classList.add('visible');
    bulkActionsText.textContent = `${selectedRows.size} row${selectedRows.size > 1 ? 's' : ''} selected`;
  } else {
    bulkActions.classList.remove('visible');
  }
}

function renderMatches() {
  const container = document.getElementById('matches-container');
  
  if (filteredMatches.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h2>${allMatches.length === 0 ? 'No saved matches yet' : 'No matches found'}</h2>
        <p>${allMatches.length === 0 ? 'Matches will appear here as you browse LinkedIn' : 'Try adjusting your filters'}</p>
      </div>
    `;
    return;
  }
  
  // Calculate pagination
  const start = (currentPage - 1) * pageSize;
  const end = pageSize === Infinity ? filteredMatches.length : start + pageSize;
  displayedMatches = filteredMatches.slice(start, end);
  
  const rows = displayedMatches.map(match => {
    const date = new Date(match.timestamp);
    const dateStr = date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric', 
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    
    // Keywords badge - handle both old (single keyword) and new (multiple keywords) formats
    let keywordBadge = '';
    const keywords = match.devopsKeywords || [match.devopsKeyword]; // Support both formats
    const keywordList = keywords.map(k => escapeHtml(k)).join(', ');
    
    if (match.isHiring) {
      keywordBadge = `<span class="badge badge-hiring">🔥 ${keywordList} + ${escapeHtml(match.hiringSignal)}</span>`;
    } else {
      keywordBadge = `<span class="badge badge-devops">DevOps · ${keywordList}</span>`;
    }
    
    // Add duplicate badge if this is a duplicate
    if (match.duplicateOf) {
      keywordBadge += ` <span class="badge badge-duplicate" style="background:#ff9800;color:white;padding:3px 8px;border-radius:4px;font-size:11px;margin-left:4px;" title="Duplicate of ${match.duplicateOf}">🔄 Duplicate</span>`;
    }
    
    // Status badge with color coding
    const status = match.status || 'new';
    const statusConfig = {
      'new': { label: 'New', color: '#1976d2', bg: '#e3f2fd' },
      'interested': { label: 'Interested', color: '#7b1fa2', bg: '#f3e5f5' },
      'applied': { label: 'Applied', color: '#0288d1', bg: '#e1f5fe' },
      'interviewing': { label: 'Interviewing', color: '#f57c00', bg: '#fff3e0' },
      'offer': { label: 'Offer', color: '#388e3c', bg: '#e8f5e9' },
      'rejected': { label: 'Rejected', color: '#d32f2f', bg: '#ffebee' },
      'not-interested': { label: 'Not Interested', color: '#616161', bg: '#f5f5f5' }
    };
    const statusInfo = statusConfig[status] || statusConfig['new'];
    const statusBadge = `
      <span class="status-badge" style="background:${statusInfo.bg};color:${statusInfo.color};padding:4px 8px;border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap;">
        ${statusInfo.label}
      </span>
    `;
    
    // Skills column
    let skillsHtml = '<span style="color:#999;font-size:12px;">None</span>';
    if (match.skills && match.skills.length > 0) {
      skillsHtml = match.skills.slice(0, 5).map(skill => 
        `<span class="skill-tag" style="background:#e3f2fd;color:#1565c0;padding:2px 6px;border-radius:3px;font-size:11px;margin-right:4px;display:inline-block;margin-bottom:2px;">${escapeHtml(skill)}</span>`
      ).join('');
      if (match.skills.length > 5) {
        skillsHtml += `<span style="color:#999;font-size:11px;margin-left:4px;">+${match.skills.length - 5} more</span>`;
      }
    }
    
    // Emails column
    let emailsHtml = '<span style="color:#999;font-size:12px;">None</span>';
    if (match.emails && match.emails.length > 0) {
      emailsHtml = match.emails.map(email => 
        `<a href="mailto:${escapeHtml(email)}" class="email-link" title="Email: ${escapeHtml(email)}">${escapeHtml(email)}</a>`
      ).join('');
    }
    
    // Full post text with keyword highlighting
    const fullText = match.fullText || match.snippet || 'No text available';
    let postTextHtml = escapeHtml(fullText);
    
    // Highlight DevOps keywords in yellow
    keywords.forEach(keyword => {
      const regex = new RegExp(`\\b(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'gi');
      postTextHtml = postTextHtml.replace(regex, '<mark style="background:#fff59d;color:#000;font-weight:600;padding:1px 2px;border-radius:2px;">$1</mark>');
    });
    
    // Highlight hiring signal in green background
    if (match.hiringSignal) {
      const regex = new RegExp(`\\b(${match.hiringSignal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'gi');
      postTextHtml = postTextHtml.replace(regex, '<mark style="background:#c8e6c9;color:#1b5e20;font-weight:600;padding:1px 2px;border-radius:2px;">$1</mark>');
    }
    
    // Highlight invalid keyword in orange background (if present)
    if (match.invalidKeyword) {
      const regex = new RegExp(`\\b(${match.invalidKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'gi');
      postTextHtml = postTextHtml.replace(regex, '<mark style="background:#ffe0b2;color:#e65100;font-weight:600;padding:1px 2px;border-radius:2px;">$1</mark>');
    }
    
    // Create collapsible text with "see more" functionality (LinkedIn style)
    const charLimit = 300;
    let postDisplayHtml;
    
    if (fullText.length > charLimit) {
      const previewText = escapeHtml(fullText.substring(0, charLimit));
      
      // Re-apply highlights to preview
      let previewHtml = previewText;
      keywords.forEach(keyword => {
        const regex = new RegExp(`\\b(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'gi');
        previewHtml = previewHtml.replace(regex, '<mark style="background:#fff59d;color:#000;font-weight:600;padding:1px 2px;border-radius:2px;">$1</mark>');
      });
      if (match.hiringSignal) {
        const regex = new RegExp(`\\b(${match.hiringSignal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'gi');
        previewHtml = previewHtml.replace(regex, '<mark style="background:#c8e6c9;color:#1b5e20;font-weight:600;padding:1px 2px;border-radius:2px;">$1</mark>');
      }
      if (match.invalidKeyword) {
        const regex = new RegExp(`\\b(${match.invalidKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'gi');
        previewHtml = previewHtml.replace(regex, '<mark style="background:#ffe0b2;color:#e65100;font-weight:600;padding:1px 2px;border-radius:2px;">$1</mark>');
      }
      
      postDisplayHtml = `
        <div class="post-text-container">
          <div class="post-text-preview" data-match-id="${match.id}">${previewHtml}...</div>
          <div class="post-text-full" data-match-id="${match.id}" style="display:none;">${postTextHtml}</div>
          <button class="see-more-btn" data-match-id="${match.id}" style="color:#0a66c2;background:none;border:none;padding:4px 0;cursor:pointer;font-size:14px;font-weight:600;margin-top:4px;">
            ...see more
          </button>
        </div>
      `;
    } else {
      postDisplayHtml = `<div class="post-text-full">${postTextHtml}</div>`;
    }
    
    // Actions column
    const openBtn = match.url 
      ? `<a href="${escapeHtml(match.url)}" target="_blank" class="btn-open">Open ↗</a>`
      : '';
    
    const isSelected = selectedRows.has(match.id);
    const selectedClass = isSelected ? ' class="selected"' : '';
    
    return `
      <tr data-id="${match.id}"${selectedClass}>
        <td class="col-select"><input type="checkbox" class="row-checkbox" data-match-id="${match.id}" ${isSelected ? 'checked' : ''}></td>
        <td class="col-timestamp">${dateStr}</td>
        <td class="col-keywords">${keywordBadge}</td>
        <td class="col-status">
          <select class="status-dropdown" data-match-id="${match.id}">
            <option value="new" ${status === 'new' ? 'selected' : ''}>🆕 New</option>
            <option value="interested" ${status === 'interested' ? 'selected' : ''}>⭐ Interested</option>
            <option value="applied" ${status === 'applied' ? 'selected' : ''}>📧 Applied</option>
            <option value="interviewing" ${status === 'interviewing' ? 'selected' : ''}>💼 Interviewing</option>
            <option value="offer" ${status === 'offer' ? 'selected' : ''}>🎉 Offer</option>
            <option value="rejected" ${status === 'rejected' ? 'selected' : ''}>❌ Rejected</option>
            <option value="not-interesting" ${status === 'not-interested' ? 'selected' : ''}>🚫 Not Interested</option>
          </select>
        </td>
        <td class="col-skills">${skillsHtml}</td>
        <td class="col-snippet" style="max-width:800px;white-space:pre-wrap;word-wrap:break-word;">${postDisplayHtml}</td>
        <td class="col-emails">${emailsHtml}</td>
        <td class="col-actions">
          ${openBtn}
          <button class="btn-delete" data-match-id="${match.id}">Delete</button>
        </td>
      </tr>
    `;
  }).join('');
  
  // Determine if all rows are selected
  const allSelected = displayedMatches.length > 0 && displayedMatches.every(m => selectedRows.has(m.id));
  
  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th class="col-select"><input type="checkbox" id="select-all" ${allSelected ? 'checked' : ''}></th>
          <th class="sortable${sortColumn === 'timestamp' ? (sortDirection === 'asc' ? ' sorted-asc' : ' sorted-desc') : ''}" data-column="timestamp">Date</th>
          <th class="sortable${sortColumn === 'keyword' ? (sortDirection === 'asc' ? ' sorted-asc' : ' sorted-desc') : ''}" data-column="keyword">Keywords</th>
          <th class="sortable${sortColumn === 'status' ? (sortDirection === 'asc' ? ' sorted-asc' : ' sorted-desc') : ''}" data-column="status">Status</th>
          <th>Skills</th>
          <th>Full Post (with highlights)</th>
          <th>Emails</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
  
  // Add event listeners
  attachTableEventListeners();
}

function attachTableEventListeners() {
  const container = document.getElementById('matches-container');
  
  // Select all checkbox
  const selectAllCheckbox = document.getElementById('select-all');
  if (selectAllCheckbox) {
    selectAllCheckbox.addEventListener('change', (e) => {
      const checked = e.target.checked;
      displayedMatches.forEach(match => {
        if (checked) {
          selectedRows.add(match.id);
        } else {
          selectedRows.delete(match.id);
        }
      });
      renderMatches();
      updateBulkActions();
    });
  }
  
  // Row checkboxes
  container.querySelectorAll('.row-checkbox').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const matchId = e.target.getAttribute('data-match-id');
      if (e.target.checked) {
        selectedRows.add(matchId);
      } else {
        selectedRows.delete(matchId);
      }
      updateRowSelection(matchId, e.target.checked);
      updateBulkActions();
    });
  });
  
  // Sortable headers
  container.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const column = th.getAttribute('data-column');
      if (sortColumn === column) {
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      } else {
        sortColumn = column;
        sortDirection = 'desc';
      }
      applySorting();
      renderMatches();
      updatePagination();
    });
  });
  
  // Delete buttons
  container.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const matchId = e.target.getAttribute('data-match-id');
      if (matchId) deleteMatch(matchId);
    });
  });
  
  // Status dropdowns
  container.querySelectorAll('.status-dropdown').forEach(dropdown => {
    dropdown.addEventListener('change', (e) => {
      const matchId = e.target.getAttribute('data-match-id');
      const newStatus = e.target.value;
      if (matchId) updateMatchStatus(matchId, newStatus);
    });
  });
  
  // See more/less buttons
  container.querySelectorAll('.see-more-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const matchId = e.target.getAttribute('data-match-id');
      const preview = container.querySelector(`.post-text-preview[data-match-id="${matchId}"]`);
      const full = container.querySelector(`.post-text-full[data-match-id="${matchId}"]`);
      
      if (preview && full) {
        const isExpanded = full.style.display !== 'none';
        
        if (isExpanded) {
          // Collapse - show preview, hide full
          preview.style.display = 'block';
          full.style.display = 'none';
          e.target.textContent = '...see more';
        } else {
          // Expand - hide preview, show full
          preview.style.display = 'none';
          full.style.display = 'block';
          e.target.textContent = 'see less';
        }
      }
    });
  });
}

function updateRowSelection(matchId, selected) {
  const row = document.querySelector(`tr[data-id="${matchId}"]`);
  if (row) {
    if (selected) {
      row.classList.add('selected');
    } else {
      row.classList.remove('selected');
    }
  }
}

function deleteMatch(id) {
  if (!isContextValid()) {
    extensionContextValid = false;
    showContextInvalidError();
    return;
  }
  
  if (!confirm('Delete this match? This cannot be undone.')) return;
  
  allMatches = allMatches.filter(m => m.id !== id);
  selectedRows.delete(id);
  
  safeStorageSet({ devopsSavedMatches: allMatches }).then(() => {
    updateStats();
    applyFilters();
  }).catch((error) => {
    console.error('Delete error:', error);
    extensionContextValid = false;
    showContextInvalidError();
  });
}

function cleanDuplicates() {
  if (!isContextValid()) {
    extensionContextValid = false;
    showContextInvalidError();
    return;
  }
  
  const duplicates = allMatches.filter(m => m.duplicateOf);
  const count = duplicates.length;
  
  if (count === 0) {
    alert('No duplicates found!');
    return;
  }
  
  if (!confirm(`Remove ${count} duplicate match${count > 1 ? 'es' : ''}? This will keep the original posts and remove duplicates. This cannot be undone.`)) {
    return;
  }
  
  // Filter out matches that have duplicateOf field
  allMatches = allMatches.filter(m => !m.duplicateOf);
  
  // Clear any selected duplicates
  duplicates.forEach(dup => selectedRows.delete(dup.id));
  
  safeStorageSet({ devopsSavedMatches: allMatches }).then(() => {
    alert(`Removed ${count} duplicate${count > 1 ? 's' : ''}!`);
    updateStats();
    applyFilters();
  }).catch((error) => {
    console.error('Clean duplicates error:', error);
    extensionContextValid = false;
    showContextInvalidError();
  });
}

function deleteSelected() {
  if (!isContextValid()) {
    extensionContextValid = false;
    showContextInvalidError();
    return;
  }
  
  const count = selectedRows.size;
  if (count === 0) return;
  
  if (!confirm(`Delete ${count} selected match${count > 1 ? 'es' : ''}? This cannot be undone.`)) return;
  
  allMatches = allMatches.filter(m => !selectedRows.has(m.id));
  selectedRows.clear();
  
  safeStorageSet({ devopsSavedMatches: allMatches }).then(() => {
    updateStats();
    applyFilters();
  }).catch((error) => {
    console.error('Delete selected error:', error);
    extensionContextValid = false;
    showContextInvalidError();
  });
}

function exportSelected() {
  const selectedMatches = allMatches.filter(m => selectedRows.has(m.id));
  
  if (selectedMatches.length === 0) {
    alert('No rows selected to export.');
    return;
  }
  
  const data = {
    exportedAt: new Date().toISOString(),
    totalMatches: selectedMatches.length,
    matches: selectedMatches
  };
  
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `devops-scanner-selected-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function clearAllMatches() {
  if (!isContextValid()) {
    extensionContextValid = false;
    showContextInvalidError();
    return;
  }
  
  const count = allMatches.length;
  if (!confirm(`Delete all ${count} saved matches? This cannot be undone.`)) return;
  
  safeStorageSet({ devopsSavedMatches: [] }).then(() => {
    allMatches = [];
    updateStats();
    applyFilters();
  }).catch((error) => {
    console.error('Clear all error:', error);
    extensionContextValid = false;
    showContextInvalidError();
  });
}

function exportMatches() {
  const data = {
    exportedAt: new Date().toISOString(),
    totalMatches: allMatches.length,
    matches: allMatches
  };
  
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `devops-scanner-matches-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function copyAllEmails() {
  // Collect all unique emails from filtered matches
  const allEmails = new Set();
  filteredMatches.forEach(match => {
    if (match.emails && match.emails.length > 0) {
      match.emails.forEach(email => allEmails.add(email));
    }
  });
  
  if (allEmails.size === 0) {
    alert('No emails found in the current filtered matches.');
    return;
  }
  
  // Copy to clipboard
  const emailList = Array.from(allEmails).join(', ');
  navigator.clipboard.writeText(emailList).then(() => {
    // Show temporary success message
    const btn = document.getElementById('btn-copy-emails');
    const originalText = btn.textContent;
    btn.textContent = `✓ Copied ${allEmails.size} email${allEmails.size > 1 ? 's' : ''}`;
    btn.style.background = '#2e7d32';
    setTimeout(() => {
      btn.textContent = originalText;
      btn.style.background = '#666';
    }, 2000);
  }).catch(err => {
    alert('Failed to copy emails to clipboard: ' + err);
  });
}

function convertToCSV(matches) {
  if (matches.length === 0) return '';
  
  // Define CSV headers
  const headers = [
    'ID',
    'Timestamp',
    'Date',
    'Author',
    'Type',
    'URL',
    'Snippet',
    'DevOps Keywords',
    'Skills',
    'Hiring Signals',
    'Is Hiring',
    'Is Duplicate',
    'Duplicate Of'
  ];
  
  // Escape CSV field (handle quotes and commas)
  const escapeCSV = (field) => {
    if (field == null) return '';
    const str = String(field);
    if (str.includes('"') || str.includes(',') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  
  // Create CSV rows
  const rows = matches.map(match => {
    const date = match.timestamp ? new Date(match.timestamp).toLocaleString() : '';
    const devopsKeywords = (match.devopsKeywords || []).join('; ');
    const skills = (match.skills || []).join('; ');
    const hiringSignals = (match.hiringSignals || []).join('; ');
    
    return [
      escapeCSV(match.id),
      escapeCSV(match.timestamp),
      escapeCSV(date),
      escapeCSV(match.author),
      escapeCSV(match.isHiring ? 'Hiring' : 'DevOps'),
      escapeCSV(match.url),
      escapeCSV(match.snippet || match.fullText?.substring(0, 200)),
      escapeCSV(devopsKeywords),
      escapeCSV(skills),
      escapeCSV(hiringSignals),
      escapeCSV(match.isHiring ? 'Yes' : 'No'),
      escapeCSV(match.duplicateOf ? 'Yes' : 'No'),
      escapeCSV(match.duplicateOf || '')
    ].join(',');
  });
  
  // Combine headers and rows
  return [headers.join(','), ...rows].join('\n');
}

function exportMatchesCSV() {
  const csv = convertToCSV(allMatches);
  
  if (!csv) {
    alert('No matches to export!');
    return;
  }
  
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `devops-scanner-matches-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportSelectedCSV() {
  if (selectedRows.size === 0) {
    alert('No rows selected!');
    return;
  }
  
  const selectedMatches = allMatches.filter(m => selectedRows.has(m.id));
  const csv = convertToCSV(selectedMatches);
  
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `devops-scanner-selected-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// Event listeners
document.getElementById('btn-refresh').addEventListener('click', loadMatches);
document.getElementById('btn-copy-emails').addEventListener('click', copyAllEmails);
document.getElementById('btn-export').addEventListener('click', exportMatches);
document.getElementById('btn-export-csv').addEventListener('click', exportMatchesCSV);
document.getElementById('btn-clear-all').addEventListener('click', clearAllMatches);
document.getElementById('btn-clean-duplicates').addEventListener('click', cleanDuplicates);

// Bulk action buttons
document.getElementById('btn-delete-selected').addEventListener('click', deleteSelected);
document.getElementById('btn-export-selected').addEventListener('click', exportSelected);
document.getElementById('btn-export-selected-csv').addEventListener('click', exportSelectedCSV);
document.getElementById('btn-deselect-all').addEventListener('click', () => {
  selectedRows.clear();
  renderMatches();
  updateBulkActions();
});

// Pagination buttons
document.getElementById('btn-first-page').addEventListener('click', () => goToPage(1));
document.getElementById('btn-prev-page').addEventListener('click', () => goToPage(currentPage - 1));
document.getElementById('btn-next-page').addEventListener('click', () => goToPage(currentPage + 1));
document.getElementById('btn-last-page').addEventListener('click', () => {
  const totalPages = Math.ceil(filteredMatches.length / pageSize);
  goToPage(totalPages);
});

let filterTimeout;
['filter-input', 'filter-type', 'filter-skill', 'filter-duplicate', 'sort-by', 'page-size'].forEach(id => {
  const element = document.getElementById(id);
  if (element) {
    element.addEventListener('input', () => {
      clearTimeout(filterTimeout);
      filterTimeout = setTimeout(applyFilters, 300);
    });
    element.addEventListener('change', applyFilters);
  }
});

// Listen for storage changes and update instantly
try {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (!isContextValid()) {
      extensionContextValid = false;
      return;
    }
    if (areaName === 'local' && changes.devopsSavedMatches) {
      loadMatches();
    }
  });
} catch (e) {
  console.error('Failed to setup storage listener:', e);
  extensionContextValid = false;
  showContextInvalidError();
}

// Auto-refresh every 10 seconds as backup
window.refreshInterval = setInterval(() => {
  if (isContextValid()) {
    loadMatches();
  }
}, 10000);

// Initial load
loadMatches();
