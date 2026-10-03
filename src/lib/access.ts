// Access control for source vault and demo features
export function canDownloadSource(email: string | undefined): boolean {
  if (!email) {
    return false;
  }

  // List of emails that can download the source code
  const authorizedEmails = [
    "owner@example.com", // Replace with actual owner email
    "admin@example.com", // Replace with actual admin email
  ];

  return authorizedEmails.includes(email.toLowerCase());
}

export function isDemoAdmin(email: string | undefined): boolean {
  if (!email) {
    return false;
  }

  const demoAdmins = [
    "admin@example.com",
  ];

  return demoAdmins.includes(email.toLowerCase());
}

export function canAccessFeature(
  email: string | undefined,
  feature: "download-source" | "demo" | "admin"
): boolean {
  if (!email) {
    return false;
  }

  switch (feature) {
    case "download-source":
      return canDownloadSource(email);
    case "demo":
      return isDemoAdmin(email);
    case "admin":
      return isDemoAdmin(email);
    default:
      return false;
  }
}