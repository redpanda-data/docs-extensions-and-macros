/**
 * MCP Tools - Background Job Queue
 *
 * Manages long-running documentation generation jobs with progress tracking
 * and streaming updates via MCP notifications.
 */

const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { DEFAULT_COMMAND_TIMEOUT } = require('./utils');

// Job status enum
const JobStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

// In-memory job storage
const jobs = new Map();

// Reference to MCP server for sending notifications
let mcpServer = null;

/**
 * Initialize the job queue with MCP server reference
 * @param {Object} server - MCP server instance
 */
function initializeJobQueue(server) {
  mcpServer = server;
}

/**
 * Create a new background job
 * @param {string} toolName - Name of the tool
 * @param {string|Array} command - Command to execute (array format preferred for security)
 * @param {Object} options - Execution options
 * @returns {string} Job ID
 */
function createJob(toolName, command, options = {}) {
  const jobId = randomUUID();

  const job = {
    id: jobId,
    tool: toolName,
    command,
    status: JobStatus.PENDING,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    progress: 0,
    progressMessage: 'Job queued',
    output: '',
    error: null,
    result: null
  };

  jobs.set(jobId, job);

  // Start job execution immediately (can be changed to queue-based if needed)
  executeJob(jobId, command, options);

  return jobId;
}

/**
 * Parse a command string into executable and arguments
 * Handles basic quoted arguments safely
 */
function parseCommand(command) {
  const args = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';
  
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    
    if (!inQuotes && (char === '"' || char === "'")) {
      inQuotes = true;
      quoteChar = char;
    } else if (inQuotes && char === quoteChar) {
      inQuotes = false;
      quoteChar = '';
    } else if (!inQuotes && char === ' ') {
      if (current.trim()) {
        args.push(current.trim());
        current = '';
      }
    } else {
      current += char;
    }
  }
  
  if (current.trim()) {
    args.push(current.trim());
  }
  
  return args;
}

/**
 * Validate that an executable is safe to run
 * Whitelist known safe executables
 */
function isValidExecutable(executable) {
  const allowedExecutables = [
    'npx',
    'node', 
    'npm',
    'yarn',
    'doc-tools',
    'helm-docs',
    'crd-ref-docs',
    'git',
    'make',
    'docker',
    'timeout'
  ];
  
  // Allow absolute paths to known tools in common locations
  const allowedPaths = [
    '/usr/bin/',
    '/usr/local/bin/',
    '/bin/',
    '/opt/homebrew/bin/'
  ];
  
  // Check if it's a whitelisted executable
  if (allowedExecutables.includes(executable)) {
    return true;
  }
  
  // Check if it's an absolute path to a whitelisted location
  if (executable.startsWith('/')) {
    return allowedPaths.some(path => 
      executable.startsWith(path) && 
      allowedExecutables.some(exe => executable.endsWith(`/${exe}`) || executable.endsWith(`/${exe}.exe`))
    );
  }
  
  return false;
}

/**
 * Execute a job in the background
 * @param {string} jobId - Job ID
 * @param {string|Array} command - Command to execute (string will be parsed, array is preferred)
 * @param {Object} options - Execution options
 */
async function executeJob(jobId, command, options = {}) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    job.status = JobStatus.RUNNING;
    job.startedAt = new Date().toISOString();
    updateJobProgress(jobId, 10, 'Starting execution...');

    const cwd = options.cwd || process.cwd();
    const timeout = options.timeout || DEFAULT_COMMAND_TIMEOUT;

    let executable, args;

    if (Array.isArray(command)) {
      // Preferred: pre-parsed array [executable, ...args]
      [executable, ...args] = command;
    } else if (typeof command === 'string') {
      // Legacy string command - use safer parsing
      // Basic parsing that handles simple quoted arguments
      const parsedArgs = parseCommand(command);
      [executable, ...args] = parsedArgs;
    } else {
      throw new Error('Command must be a string or array');
    }

    // Validate executable to prevent injection
    if (!isValidExecutable(executable)) {
      throw new Error(`Invalid executable: ${executable}`);
    }

    const childProcess = spawn(executable, args, {
      cwd,
      shell: false, // Explicitly disable shell to prevent injection
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      childProcess.kill('SIGTERM');
      job.error = `Job timed out after ${timeout}ms`;
      job.status = JobStatus.FAILED;
      job.completedAt = new Date().toISOString();
      job.result = {
        success: false,
        error: job.error,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      };
      updateJobProgress(jobId, 100, 'Job timed out');
    }, timeout);

    // Capture stdout
    childProcess.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      job.output = stdout;

      // Parse progress from output if available
      parseProgressFromOutput(jobId, chunk);
    });

    // Capture stderr
    childProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Handle completion
    childProcess.on('close', (code) => {
      clearTimeout(timeoutHandle);

      // If job already timed out, don't overwrite the timeout error
      if (timedOut) {
        return;
      }

      job.completedAt = new Date().toISOString();

      if (code === 0) {
        job.status = JobStatus.COMPLETED;
        job.progress = 100;
        job.progressMessage = 'Completed successfully';
        job.result = {
          success: true,
          output: stdout.trim(),
          command
        };
        updateJobProgress(jobId, 100, 'Completed successfully');
      } else {
        job.status = JobStatus.FAILED;
        job.error = stderr || `Command exited with code ${code}`;
        job.result = {
          success: false,
          error: job.error,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code
        };
        updateJobProgress(jobId, 100, `Failed with exit code ${code}`);
      }
    });

    // Handle errors
    childProcess.on('error', (err) => {
      clearTimeout(timeoutHandle);

      // If job already timed out, don't overwrite the timeout error
      if (timedOut) {
        return;
      }

      job.status = JobStatus.FAILED;
      job.error = err.message;
      job.completedAt = new Date().toISOString();
      job.result = {
        success: false,
        error: err.message
      };
      updateJobProgress(jobId, 100, `Error: ${err.message}`);
    });
  } catch (err) {
    // Catch synchronous errors (validation failures, etc.)
    // Record them on the job instead of throwing
    job.status = JobStatus.FAILED;
    job.error = err.message;
    job.completedAt = new Date().toISOString();
    job.result = {
      success: false,
      error: err.message
    };
    updateJobProgress(jobId, 100, `Error: ${err.message}`);
  }
}

/**
 * Parse progress information from command output
 * @param {string} jobId - Job ID
 * @param {string} output - Output chunk
 */
function parseProgressFromOutput(jobId, output) {
  const job = jobs.get(jobId);
  if (!job) return;

  // Look for common progress patterns
  const patterns = [
    // Percentage: "Progress: 45%", "45%", "[45%]"
    /(?:progress[:\s]*)?(\d+)%/i,
    // Step indicators: "Step 3/5", "3 of 5"
    /(?:step\s+)?(\d+)\s*(?:\/|of)\s*(\d+)/i,
    // Processing indicators: "Processing file 3 of 10"
    /processing.*?(\d+)\s*of\s*(\d+)/i,
    // Cloning/downloading indicators
    /(?:cloning|downloading|fetching)/i,
    // Building indicators
    /(?:building|compiling|generating)/i,
    // Analyzing indicators
    /(?:analyzing|parsing|extracting)/i
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) {
      if (match.length === 2) {
        // Percentage match
        const percentage = parseInt(match[1]);
        if (percentage >= 0 && percentage <= 100) {
          updateJobProgress(jobId, percentage, output.trim().split('\n').pop());
          return;
        }
      } else if (match.length === 3) {
        // Step match (e.g., "3/5")
        const current = parseInt(match[1]);
        const total = parseInt(match[2]);
        const percentage = Math.round((current / total) * 100);
        updateJobProgress(jobId, percentage, output.trim().split('\n').pop());
        return;
      }
    }
  }

  // If we find action keywords but no percentage, estimate progress based on job runtime
  const actionKeywords = ['cloning', 'downloading', 'fetching', 'building', 'compiling', 'generating', 'analyzing', 'parsing', 'extracting'];
  const hasAction = actionKeywords.some(keyword => output.toLowerCase().includes(keyword));

  if (hasAction && job.progress < 90) {
    // Gradually increase progress for long-running jobs
    const elapsed = new Date() - new Date(job.startedAt);
    const estimatedTotal = DEFAULT_COMMAND_TIMEOUT;
    const estimatedProgress = Math.min(90, Math.round((elapsed / estimatedTotal) * 100));

    if (estimatedProgress > job.progress) {
      updateJobProgress(jobId, estimatedProgress, output.trim().split('\n').pop());
    }
  }
}

/**
 * Update job progress and send notification
 * @param {string} jobId - Job ID
 * @param {number} progress - Progress percentage (0-100)
 * @param {string} message - Progress message
 */
function updateJobProgress(jobId, progress, message) {
  const job = jobs.get(jobId);
  if (!job) return;

  job.progress = Math.min(100, Math.max(0, progress));
  job.progressMessage = message;

  // Send MCP notification if server is initialized
  if (mcpServer) {
    try {
      mcpServer.notification({
        method: 'notifications/progress',
        params: {
          progressToken: jobId,
          progress: job.progress,
          total: 100,
          message: message
        }
      });
    } catch (err) {
      // Ignore notification errors - they shouldn't stop the job
      console.error(`Failed to send progress notification: ${err.message}`);
    }
  }
}

/**
 * Get job status
 * @param {string} jobId - Job ID
 * @returns {Object|null} Job status or null if not found
 */
function getJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;

  return {
    id: job.id,
    tool: job.tool,
    status: job.status,
    progress: job.progress,
    progressMessage: job.progressMessage,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
    result: job.result
  };
}

/**
 * Get all jobs
 * @param {Object} filter - Optional filter
 * @returns {Array} List of jobs
 */
function listJobs(filter = {}) {
  const jobList = Array.from(jobs.values());

  return jobList
    .filter(job => {
      if (filter.status && job.status !== filter.status) return false;
      if (filter.tool && job.tool !== filter.tool) return false;
      return true;
    })
    .map(job => ({
      id: job.id,
      tool: job.tool,
      status: job.status,
      progress: job.progress,
      progressMessage: job.progressMessage,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * Clean up old completed/failed jobs
 * @param {number} maxAge - Maximum age in milliseconds (default: 1 hour)
 */
function cleanupOldJobs(maxAge = 60 * 60 * 1000) {
  const now = Date.now();
  let removed = 0;

  for (const [jobId, job] of jobs.entries()) {
    if (job.status === JobStatus.COMPLETED || job.status === JobStatus.FAILED) {
      const jobTime = new Date(job.completedAt || job.createdAt).getTime();
      if (now - jobTime > maxAge) {
        jobs.delete(jobId);
        removed++;
      }
    }
  }

  return removed;
}

// Clean up old jobs every 10 minutes
setInterval(() => {
  cleanupOldJobs();
}, 10 * 60 * 1000);

module.exports = {
  JobStatus,
  initializeJobQueue,
  createJob,
  getJob,
  listJobs,
  cleanupOldJobs
};
