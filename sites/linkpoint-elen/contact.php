<?php
/**
 * Linkpoint Elen Construction — contact form handler
 * ---------------------------------------------------
 * OPTIONAL. Only needed if you'd rather use Hostinger's own PHP mail
 * instead of Web3Forms.
 *
 * To use it:
 *   1. Set $TO_EMAIL below to the address that should receive leads.
 *   2. In index.html, change the form tag to:  action="contact.php"
 *   3. In index.html, delete the hidden "access_key" input.
 *
 * Note: Hostinger requires the "from" address to be on your own domain,
 * so leave $FROM_EMAIL on your real domain or the mail may be rejected.
 */

$TO_EMAIL   = 'alexhelms@lunexmarketing.com';        // <-- EDIT
$FROM_EMAIL = 'website@linkpointelen.com';           // <-- EDIT (must be your domain)
$SITE_NAME  = 'Linkpoint Elen Construction';

header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

// Honeypot — bots fill hidden fields, humans don't.
if (!empty($_POST['botcheck'])) {
    echo json_encode(['success' => true]);
    exit;
}

function clean($key, $max = 2000) {
    $v = isset($_POST[$key]) ? trim((string) $_POST[$key]) : '';
    $v = str_replace(["\r", "\n", "%0a", "%0d"], ' ', $v); // header-injection guard
    return mb_substr($v, 0, $max);
}

$name     = clean('name', 120);
$phone    = clean('phone', 40);
$email    = clean('email', 160);
$zip      = clean('zip', 20);
$project  = clean('project', 80);
$timeline = clean('timeline', 80);
$details  = isset($_POST['details']) ? mb_substr(trim((string) $_POST['details']), 0, 5000) : '';

if ($name === '' || $phone === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    http_response_code(422);
    echo json_encode(['success' => false, 'message' => 'Please fill in your name, phone, and a valid email.']);
    exit;
}

$body = "New estimate request from the website\n"
      . "----------------------------------------\n\n"
      . "Name:      {$name}\n"
      . "Phone:     {$phone}\n"
      . "Email:     {$email}\n"
      . "ZIP:       " . ($zip ?: '—') . "\n"
      . "Project:   " . ($project ?: '—') . "\n"
      . "Timeline:  " . ($timeline ?: '—') . "\n\n"
      . "Details:\n" . ($details !== '' ? $details : '—') . "\n\n"
      . "----------------------------------------\n"
      . "Submitted: " . date('D, M j Y \a\t g:i a') . "\n";

$headers  = "From: {$SITE_NAME} <{$FROM_EMAIL}>\r\n";
$headers .= "Reply-To: {$name} <{$email}>\r\n";
$headers .= "Content-Type: text/plain; charset=UTF-8\r\n";

$subject = "New estimate request — {$name}" . ($project ? " ({$project})" : '');

if (mail($TO_EMAIL, $subject, $body, $headers)) {
    echo json_encode(['success' => true]);
} else {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Mail server error']);
}
