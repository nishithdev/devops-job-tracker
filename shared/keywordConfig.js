// LinkedIn DevOps Scanner - Keyword Configuration
// Single source of truth for all keyword arrays

// DevOps keywords — posts must contain at least one of these to be considered a match.
// Includes both role/function terms and the specific technologies that appear in job posts.
const DEFAULT_DEVOPS_KEYWORDS = [
  // Roles & functions
  "devops",
  "dev ops",
  "sre",
  "devops engineer",
  "azure devops engineer",
  "site reliability",
  "platform engineer",
  "platform engineering",
  "cloud engineer",
  "cloud support engineer",
  "cloud engineering",
  "cloud architect",
  "cloud developer",
  "cloud devops",
  "cloud infrastructure",
  "cloud operations",
  "cloud ops",
  "aws engineer",
  "azure engineer",
  "gcp engineer",
  "infrastructure engineer",
  "release engineer",

  // Container & orchestration
  "docker",
  "kubernetes",
  "k8s",
  "aks",
  "eks",
  "gke",
  "helm",
  "openshift",
  "rancher",

  // IaC & config management
  "terraform",
  "ansible",
  "cloudformation",
  "puppet",
  "chef",
  "saltstack",

  // CI/CD & pipelines
  "ci/cd",
  "jenkins",
  "github actions",
  "gitlab ci",
  "circleci",
  "travis ci",
  "argocd",
  "spinnaker",
  

  // Cloud providers
  "aws",
  "azure",
  "gcp",
  "google cloud",

  // Observability & monitoring
  "prometheus",
  "grafana",
  "datadog",
  "splunk",
  "elk",
  "elasticsearch",
  "logstash",
  "kibana",
  "new relic",
  "pagerduty",
  "monitoring",
  "observability",

  // Service mesh & networking
  "istio",
  "linkerd",
  "envoy",
  "nginx",
  "apache",

  // Scripting & languages
  "python",
  "bash",
  "shell script",
  "golang",
  "go lang",
  "java",
  ".net",
  "react.js",
  "nodejs",
  "node.js",
  "powershell",
  "power shell",
  "lamda",
  "rds",
  "vnet",
  "apim",
  "app gateway",

  // Databases & messaging
  "mongodb",
  "postgresql",
  "mysql",
  "redis",
  "cassandra",
  "kafka",
  "rabbitmq",

  // Source control & collaboration
  "github",
  "gitlab",
  "sonarqube",
  "veracode",
  "sast",
  "dast",
  "sca",
  "devsecops",
  "spring boot",
  "springboot",


  // Linux & OS
  "linux",
  "ubuntu",
  "centos",
  "redhat",
  "gitops",

  // Secrets & service discovery
  "vault",
  "nomad",
  "keyvault",

  //AWS tools
  "iam",
  "vpc",
  "ec2",
  "load balancing",
  "containerization",
  "s3",
  "cloudwatch",
  "databricks",
  "pyspark",
  "spark",
];

// Hiring signals - stronger match if present
const DEFAULT_HIRING_SIGNALS = [
  "hiring",
  "we're hiring",
  "we are hiring",
  "open role",
  "open position",
  "open positions",
  "now hiring",
  "looking for",
  "join our team",
  "join us",
  "apply now",
  "apply here",
  "actively hiring",
  "immediate opening",
  "immediate openings",
  "job opening",
  "job openings",
  "vacancy",
  "vacancies",
  "career opportunity",
  "we're recruiting",
  "we are recruiting",
];

// Invalid keywords — posts that contain ANY of these are shown as "⚠️ Not valid"
// and are never saved.  Covers both hard disqualifiers (citizenship/visa/no-c2c)
// and noise/training content (bootcamps, courses) that sometimes slip through
// with hiring signals.
const DEFAULT_INVALID_KEYWORDS = [
  // Citizenship / visa restrictions
  "usc only",
  "only usc",
  "us citizen only",
  "only us citizen",
  "us citizens only",
  "only us citizens",
  "must be usc",
  "must be us citizen",
  "citizenship required",
  "us citizenship required",
  "no visa sponsorship",
  "no sponsorship",
  "no h1b",
  "gc holders only",
  "green card only",
  "only green card",
  "visa: usc",

  // Contract / engagement type exclusions
  "w2 only",
  "w-2 only",
  "only w2",
  "only w-2",
  "contract on w2",
  "no c2c",
  "no corp to corp",

  // Not a real job post
  "not - a - hiring post",
  "not a hiring post",
  "available it consultants",
  "available on bench",
  "candidates on the bench",
  "don't send resumes",
  "not for bench sales",
  "available c2c consultants",
  "market your profile",

  // Training / courses / bootcamps
  "bootcamp",
  "boot camp",
  "online course",
  "video course",
  "learning course",
  "udemy course",
  "free course",
  "paid course",
  "devops course",
  "tutorial",
  "certification prep",
  "learn devops",
  "learning path",
  "online class",
  "webinar",
  "workshop",
  "devops training program",
  "training bootcamp",
  "training certification",
  "udemy",
  "coursera",
  "pluralsight",
  "linkedin learning",
];

// Combined defaults object for easy access
const DEFAULT_KEYWORDS = {
  devopsKeywords: DEFAULT_DEVOPS_KEYWORDS,
  hiringSignals: DEFAULT_HIRING_SIGNALS,
  invalidKeywords: DEFAULT_INVALID_KEYWORDS,
};
