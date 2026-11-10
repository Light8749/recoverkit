<?php
/**
 * RecoverKit server SDK for PHP / Laravel (layer 3).
 *
 *   $rk = new RecoverKit(env('RK_PUBLIC_KEY'), env('RK_SECRET_KEY'), env('RK_ENDPOINT'));
 *   $rk->identify(['email' => $user->email, 'phone' => $user->phone, 'firstName' => $user->first_name]);
 *
 *   // In your VTU purchase function, right after the vendor API returns success:
 *   $rk->trackPurchase(['email' => $user->email, 'amount' => $amountKobo, 'ref' => $order->reference]);
 *
 * Calls never throw by default, and time out after 3 seconds, so a RecoverKit
 * problem can never break a customer's purchase.
 */

declare(strict_types=1);

final class RecoverKit
{
    public const HASH_VERSION = 'rk1';

    private string $publicKey;
    private string $secretKey;
    private string $endpoint;
    private float $timeout;
    private bool $throwOnError;

    public function __construct(string $publicKey, string $secretKey, string $endpoint = 'https://api.recoverkit.app', float $timeout = 3.0, bool $throwOnError = false)
    {
        if (!preg_match('/^rk_pub_[0-9a-f]{24}$/', $publicKey)) {
            throw new InvalidArgumentException('RecoverKit: publicKey (rk_pub_...) required');
        }
        if (strpos($secretKey, 'rk_sec_') !== 0) {
            throw new InvalidArgumentException('RecoverKit: secretKey (rk_sec_...) required');
        }
        $parts = parse_url($endpoint);
        $host = $parts['host'] ?? '';
        $local = in_array($host, ['localhost', '127.0.0.1', '::1', '[::1]'], true);
        if (($parts['scheme'] ?? '') !== 'https' && !$local) {
            throw new InvalidArgumentException('RecoverKit: endpoint must use https');
        }
        $this->publicKey = $publicKey;
        $this->secretKey = $secretKey;
        $this->endpoint = rtrim($endpoint, '/');
        $this->timeout = $timeout;
        $this->throwOnError = $throwOnError;
    }

    // ---- identity rules: must match sdk/core/identity.js exactly ----

    public static function normalizeEmail($input): ?string
    {
        if (!is_string($input)) return null;
        $e = mb_strtolower(trim($input), 'UTF-8');
        if (strlen($e) > 254 || !preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/u', $e)) return null;
        return $e;
    }

    public static function normalizePhone($input, string $defaultCountry = '234'): ?string
    {
        if (!is_string($input) && !is_int($input)) return null;
        $s = trim((string)$input);
        $hadPlus = strpos($s, '+') === 0;
        $s = preg_replace('/\D/', '', $s);
        if (strpos($s, '00') === 0) {
            $s = substr($s, 2);
        } elseif (!$hadPlus) {
            if ($defaultCountry === '234') {
                if (strlen($s) === 11 && $s[0] === '0') $s = '234' . substr($s, 1);
                elseif (strlen($s) === 10 && preg_match('/^[789]/', $s)) $s = '234' . $s;
            } elseif (strpos($s, '0') === 0) {
                $s = $defaultCountry . substr($s, 1);
            }
        }
        if (strlen($s) === 14 && strpos($s, '2340') === 0) $s = '234' . substr($s, 4);
        if ($s === '' || $s[0] === '0') return null;
        if (strpos($s, '234') === 0 && strlen($s) !== 13) return null;
        if (strlen($s) < 8 || strlen($s) > 15) return null;
        return $s;
    }

    public function hashes(array $user): array
    {
        $out = [];
        $e = self::normalizeEmail($user['email'] ?? null);
        if ($e !== null) $out[] = hash('sha256', self::HASH_VERSION . '|' . $this->publicKey . '|e|' . $e);
        $p = self::normalizePhone($user['phone'] ?? null);
        if ($p !== null) $out[] = hash('sha256', self::HASH_VERSION . '|' . $this->publicKey . '|p|' . $p);
        return $out;
    }

    // ---- API ----

    public function identify(array $user, bool $shareContact = true): array
    {
        $ids = $this->ids($user);
        if (!$ids) return ['ok' => false, 'error' => 'no identity'];
        $body = ['ids' => $ids];
        if (!empty($user['anonId'])) $body['anonId'] = (string)$user['anonId'];
        if ($shareContact) {
            $body['contact'] = ['email' => $user['email'] ?? null, 'phone' => $user['phone'] ?? null, 'firstName' => $user['firstName'] ?? null];
        }
        return $this->post('/v1/server/events', $body);
    }

    /** amount is in kobo (minor units). Use the payment reference as ref so webhooks dedupe. */
    public function trackPurchase(array $p): array
    {
        return $this->event($p, 'purchase');
    }

    /** A wallet deposit is not a sale. */
    public function walletFunded(array $p): array
    {
        return $this->event($p, 'wallet_funded');
    }

    public function erase(array $user): array
    {
        $ids = $this->ids($user);
        if (!$ids) return ['ok' => false, 'error' => 'no identity'];
        return $this->post('/v1/server/erase', ['ids' => $ids]);
    }

    private function event(array $p, string $type): array
    {
        $ids = $this->ids($p);
        if (!$ids) return ['ok' => false, 'error' => 'no identity'];
        $ev = ['type' => $type, 'amount' => isset($p['amount']) ? (int)$p['amount'] : null];
        foreach (['currency', 'ref', 'name'] as $k) if (isset($p[$k])) $ev[$k] = (string)$p[$k];
        return $this->post('/v1/server/events', ['ids' => $ids, 'events' => [$ev]]);
    }

    private function ids(array $user): array
    {
        $ids = $this->hashes($user);
        if (!$ids && $this->throwOnError) throw new InvalidArgumentException('RecoverKit: valid email or phone required');
        return $ids;
    }

    private function post(string $path, array $body): array
    {
        try {
            $ch = curl_init($this->endpoint . $path);
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode($body, JSON_THROW_ON_ERROR),
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $this->secretKey],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT_MS => (int)($this->timeout * 1000),
                CURLOPT_CONNECTTIMEOUT_MS => (int)($this->timeout * 1000),
                CURLOPT_SSL_VERIFYPEER => true,
                CURLOPT_SSL_VERIFYHOST => 2,
                CURLOPT_FOLLOWLOCATION => false,
            ]);
            $raw = curl_exec($ch);
            $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            $err = curl_error($ch);
            curl_close($ch);
            if ($raw === false) throw new RuntimeException('RecoverKit request failed: ' . $err);
            $json = json_decode((string)$raw, true) ?: [];
            if ($status < 200 || $status >= 300) throw new RuntimeException('RecoverKit ' . $status . ': ' . ($json['error'] ?? 'request failed'));
            return $json;
        } catch (Throwable $e) {
            if ($this->throwOnError) throw $e;
            return ['ok' => false, 'error' => $e->getMessage()];
        }
    }
}
