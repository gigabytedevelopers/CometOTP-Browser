// Recomputes vectors/v1.json with the Java crypto APIs that CometOTP for Android uses
// (KeyAgreement "ECDH", Cipher "AES/GCM/NoPadding", Mac "HmacSHA256"), independently of
// generate.mjs, which uses Node and OpenSSL. Only APIs available at Android's minSdk 24 are used
// for the protocol itself; the point arithmetic below only double-checks the vector's public keys.
//
// Run with JDK 17 or later: java vectors/check-jvm/CheckVectors.java vectors/v1.json

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPrivateKeySpec;
import java.security.spec.ECPublicKeySpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

public class CheckVectors {
    // Protocol constants (docs/protocol.md, "Constants").
    static final byte[] PAIR_LABEL = utf8("CometOTP pair v1");
    static final byte[] PAIR_KEYS_INFO = utf8("CometOTP pair v1 keys");
    static final byte[] VAULT_INFO = utf8("CometOTP vault v1");
    static final byte[] SERVICE_ID_LABEL = utf8("CometOTP service v1");
    static final byte[] BLOB_MAGIC = utf8("COV1");
    static final int PAD_BLOCK = 4096;
    static final String STEAM_CHARS = "23456789BCDFGHJKMNPQRTVWXY";

    // P-256 (SEC 2, secp256r1).
    static final BigInteger P = new BigInteger("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", 16);
    static final BigInteger A = P.subtract(BigInteger.valueOf(3));
    static final BigInteger B = new BigInteger("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", 16);
    static final BigInteger[] G = {
        new BigInteger("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296", 16),
        new BigInteger("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5", 16),
    };

    static int checks = 0;

    public static void main(String[] args) throws Exception {
        @SuppressWarnings("unchecked")
        Map<String, Object> vectors = (Map<String, Object>) Json.parse(Files.readString(Path.of(args[0])));
        check(((Long) vectors.get("protocol")) == 1, "protocol version");

        Map<String, Object> vault = map(vectors.get("vault"));
        checkPairing(map(vectors.get("pairing")), vault);
        checkVault(vault);
        for (Object item : list(vectors.get("service_ids"))) {
            Map<String, Object> v = map(item);
            check(serviceId(base32(str(v, "secret"))).equals(str(v, "id")), "service id of " + str(v, "secret"));
        }
        for (Object item : list(vectors.get("codes")))
            checkCode(map(item));
        for (Object item : list(vectors.get("reject")))
            checkRejected(map(item), map(vectors.get("pairing")), vault);

        System.out.println("All " + checks + " checks passed.");
    }

    // --- Pairing ------------------------------------------------------------------------------

    static void checkPairing(Map<String, Object> v, Map<String, Object> vault) throws Exception {
        byte[] browserPrivate = hex(str(v, "browser_private"));
        byte[] phonePrivate = hex(str(v, "phone_private"));
        byte[] browserPublic = b64u(str(v, "browser_public"));
        byte[] phonePublic = b64u(str(v, "phone_public"));
        byte[] secret = b64u(str(v, "secret"));
        byte[] channel = b64u(str(v, "channel"));
        String relay = str(v, "relay");
        String browserName = str(v, "browser_name");

        same(encodePoint(multiply(new BigInteger(1, browserPrivate), G)), browserPublic, "browser public key");
        same(encodePoint(multiply(new BigInteger(1, phonePrivate), G)), phonePublic, "phone public key");
        check(channel.length == 16 && secret.length == 32, "channel and secret lengths");

        // The QR code.
        URI uri = URI.create(str(v, "uri"));
        check(uri.getScheme().equals("cometotp") && uri.getHost().equals("pair"), "URI scheme and host");
        Map<String, String> query = new HashMap<>();
        for (String pair : uri.getRawQuery().split("&")) {
            int eq = pair.indexOf('=');
            query.put(pair.substring(0, eq), URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8));
        }
        check(query.get("v").equals("1"), "URI v");
        check(query.get("r").equals(relay), "URI r");
        same(b64u(query.get("c")), channel, "URI c");
        same(b64u(query.get("k")), browserPublic, "URI k");
        same(b64u(query.get("s")), secret, "URI s");
        check(query.get("n").equals(browserName), "URI n");

        // Both sides reach the same keys and SAS.
        byte[] shared = ecdh(privateKey(phonePrivate), publicKey(browserPublic));
        same(ecdh(privateKey(browserPrivate), publicKey(phonePublic)), shared, "ECDH from the browser's side");
        same(shared, hex(str(v, "shared")), "shared secret");
        check(shared.length == 32, "shared secret keeps its leading zero bytes");

        byte[] transcript = sha256(PAIR_LABEL, lp(utf8(relay)), channel, browserPublic, lp(utf8(browserName)), phonePublic);
        same(transcript, hex(str(v, "transcript")), "transcript hash");
        byte[] okm = hkdf(concat(shared, secret), transcript, PAIR_KEYS_INFO, 68);
        same(okm, hex(str(v, "okm")), "okm");
        byte[] keyToBrowser = Arrays.copyOfRange(okm, 0, 32);
        byte[] keyToPhone = Arrays.copyOfRange(okm, 32, 64);
        same(keyToBrowser, b64u(str(v, "key_to_browser")), "key to browser");
        same(keyToPhone, b64u(str(v, "key_to_phone")), "key to phone");
        long sas = (ByteBuffer.wrap(okm, 64, 4).getInt() & 0xffffffffL) % 1_000_000;
        String digits = String.format("%06d", sas);
        check((digits.substring(0, 3) + " " + digits.substring(3)).equals(str(v, "sas")), "SAS");

        // The four messages, opened and sealed again byte for byte.
        String[] expectedTypes = { "hello", "confirm", "vault", "done" };
        List<Object> messages = list(v.get("messages"));
        check(messages.size() == 4, "four pairing messages");
        for (int i = 0; i < 4; i++) {
            Map<String, Object> m = map(messages.get(i));
            boolean toBrowser = str(m, "direction").equals("to-browser");
            int index = ((Long) m.get("index")).intValue();
            byte[] key = toBrowser ? keyToBrowser : keyToPhone;
            byte[] aad = concat(PAIR_LABEL, channel, new byte[] { (byte) (toBrowser ? 1 : 2), (byte) index });
            same(aad, hex(str(m, "aad")), "aad of message " + (i + 1));

            byte[] frame = b64u(str(m, "frame"));
            int start = 0;
            if (i == 0) {
                same(Arrays.copyOfRange(frame, 0, 65), phonePublic, "hello starts with the phone's public key");
                start = 65;
            }
            byte[] nonce = Arrays.copyOfRange(frame, start, start + 12);
            same(nonce, b64u(str(m, "nonce")), "nonce of message " + (i + 1));
            byte[] plaintext = open(key, nonce, aad, Arrays.copyOfRange(frame, start + 12, frame.length));
            check(new String(plaintext, StandardCharsets.UTF_8).equals(str(m, "plaintext")), "plaintext of message " + (i + 1));
            byte[] resealed = concat(i == 0 ? phonePublic : new byte[0], nonce, seal(key, nonce, aad, plaintext));
            same(resealed, frame, "message " + (i + 1) + " sealed again");

            Map<String, Object> body = map(Json.parse(str(m, "plaintext")));
            check(str(body, "t").equals(expectedTypes[i]), "message " + (i + 1) + " type");
            if (i == 0)
                check(str(body, "phone").equals(str(v, "phone_name")), "hello carries the phone name");
            if (i == 2) {
                check(str(body, "id").equals(str(vault, "id")), "vault message id");
                check(str(body, "read").equals(str(vault, "read_token")), "vault message read token");
                check(str(body, "key").equals(str(vault, "key")), "vault message key");
            }
        }
    }

    // --- Vault --------------------------------------------------------------------------------

    static void checkVault(Map<String, Object> v) throws Exception {
        byte[] id = b64u(str(v, "id"));
        check(id.length == 16, "vault id length");
        same(sha256(b64u(str(v, "write_token"))), b64u(str(v, "write_hash")), "write token hash");
        same(sha256(b64u(str(v, "read_token"))), b64u(str(v, "read_hash")), "read token hash");

        byte[] blobKey = hkdf(b64u(str(v, "key")), id, VAULT_INFO, 32);
        same(blobKey, b64u(str(v, "blob_key")), "blob key");

        byte[] blob = b64u(str(v, "blob"));
        byte[] header = Arrays.copyOfRange(blob, 0, 12);
        same(Arrays.copyOfRange(header, 0, 4), BLOB_MAGIC, "blob magic");
        long version = ByteBuffer.wrap(header, 4, 8).getLong();
        check(version == (Long) v.get("version"), "blob version");
        byte[] nonce = Arrays.copyOfRange(blob, 12, 24);
        same(nonce, b64u(str(v, "nonce")), "blob nonce");
        byte[] aad = concat(header, id);
        byte[] padded = open(blobKey, nonce, aad, Arrays.copyOfRange(blob, 24, blob.length));
        check(padded.length == (Long) v.get("padded_length") && padded.length % PAD_BLOCK == 0, "padded length");
        int length = ByteBuffer.wrap(padded, 0, 4).getInt();
        String payload = new String(padded, 4, length, StandardCharsets.UTF_8);
        check(payload.equals(str(v, "payload")), "payload");
        check(Arrays.equals(Arrays.copyOfRange(padded, 4 + length, padded.length), new byte[padded.length - 4 - length]),
                "padding is zeros");
        same(concat(header, nonce, seal(blobKey, nonce, aad, padded)), blob, "blob sealed again");

        Map<String, Object> body = map(Json.parse(payload));
        check((Long) body.get("v") == 1, "payload v");
        for (Object item : list(body.get("services"))) {
            Map<String, Object> service = map(item);
            check(serviceId(base32(str(service, "secret"))).equals(str(service, "id")), "payload service id");
        }
    }

    // --- Codes --------------------------------------------------------------------------------

    static void checkCode(Map<String, Object> v) throws Exception {
        String algorithm = str(v, "algorithm");
        int digits = ((Long) v.get("digits")).intValue();
        long counter = Math.floorDiv((Long) v.get("time"), (Long) v.get("period"));
        Mac mac = Mac.getInstance("Hmac" + algorithm);
        mac.init(new SecretKeySpec(base32(str(v, "secret")), "Hmac" + algorithm));
        byte[] hash = mac.doFinal(ByteBuffer.allocate(8).putLong(counter).array());
        int offset = hash[hash.length - 1] & 0x0f;
        long value = ByteBuffer.wrap(hash, offset, 4).getInt() & 0x7fffffffL;

        String code;
        if (str(v, "type").equals("steam")) {
            StringBuilder out = new StringBuilder();
            for (int i = 0; i < digits; i++) {
                out.append(STEAM_CHARS.charAt((int) (value % 26)));
                value /= 26;
            }
            code = out.toString();
        } else {
            code = String.format("%0" + digits + "d", value % BigInteger.TEN.pow(digits).longValue());
        }
        check(code.equals(str(v, "code")), "code " + v);
    }

    // --- Inputs that must be rejected ---------------------------------------------------------

    static void checkRejected(Map<String, Object> v, Map<String, Object> pairing, Map<String, Object> vault) throws Exception {
        String what = str(v, "what");
        switch (str(v, "kind")) {
            case "frame" -> {
                boolean toBrowser = str(v, "direction").equals("to-browser");
                int index = ((Long) v.get("index")).intValue();
                byte[] key = b64u(str(pairing, toBrowser ? "key_to_browser" : "key_to_phone"));
                byte[] aad = concat(PAIR_LABEL, b64u(str(pairing, "channel")), new byte[] { (byte) (toBrowser ? 1 : 2), (byte) index });
                byte[] frame = b64u(str(v, "frame"));
                int start = (Boolean) v.get("hasPhoneKey") ? 65 : 0;
                byte[] nonce = Arrays.copyOfRange(frame, start, start + 12);
                check(fails(() -> open(key, nonce, aad, Arrays.copyOfRange(frame, start + 12, frame.length))), what);
            }
            case "blob" -> {
                byte[] id = b64u(str(vault, "id"));
                byte[] blobKey = hkdf(b64u(str(vault, "key")), id, VAULT_INFO, 32);
                byte[] blob = b64u(str(v, "blob"));
                byte[] aad = concat(Arrays.copyOfRange(blob, 0, 12), id);
                check(fails(() -> open(blobKey, Arrays.copyOfRange(blob, 12, 24), aad, Arrays.copyOfRange(blob, 24, blob.length))), what);
            }
            case "public_key" -> check(fails(() -> publicKey(b64u(str(v, "key")))), what);
            default -> throw new AssertionError("unknown rejection kind in: " + what);
        }
    }

    interface Action { void run() throws Exception; }

    static boolean fails(Action action) {
        try {
            action.run();
            return false;
        } catch (AEADBadTagException | IllegalArgumentException e) {
            return true;
        } catch (Exception e) {
            throw new AssertionError("failed for the wrong reason", e);
        }
    }

    // --- Crypto, as Android would do it -------------------------------------------------------

    static ECParameterSpec p256() throws GeneralSecurityException {
        // AlgorithmParameters "EC" only exists from API 26; a generated key carries the same parameters.
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        return ((ECPublicKey) generator.generateKeyPair().getPublic()).getParams();
    }

    static PrivateKey privateKey(byte[] scalar) throws GeneralSecurityException {
        return KeyFactory.getInstance("EC").generatePrivate(new ECPrivateKeySpec(new BigInteger(1, scalar), p256()));
    }

    /** Parses an uncompressed SEC1 point, rejecting anything not on P-256, as the spec requires. */
    static PublicKey publicKey(byte[] raw) throws GeneralSecurityException {
        if (raw.length != 65 || raw[0] != 0x04)
            throw new IllegalArgumentException("not an uncompressed P-256 point");
        BigInteger x = new BigInteger(1, Arrays.copyOfRange(raw, 1, 33));
        BigInteger y = new BigInteger(1, Arrays.copyOfRange(raw, 33, 65));
        if (x.compareTo(P) >= 0 || y.compareTo(P) >= 0
                || !y.pow(2).mod(P).equals(x.pow(3).add(A.multiply(x)).add(B).mod(P)))
            throw new IllegalArgumentException("point is not on P-256");
        return KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(new ECPoint(x, y), p256()));
    }

    static byte[] ecdh(PrivateKey own, PublicKey other) throws GeneralSecurityException {
        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(own);
        agreement.doPhase(other, true);
        return agreement.generateSecret();
    }

    static byte[] hmac(byte[] key, byte[]... parts) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        for (byte[] part : parts)
            mac.update(part);
        return mac.doFinal();
    }

    /** RFC 5869 with SHA-256. */
    static byte[] hkdf(byte[] ikm, byte[] salt, byte[] info, int length) throws GeneralSecurityException {
        byte[] prk = hmac(salt.length == 0 ? new byte[32] : salt, ikm);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] block = new byte[0];
        for (int i = 1; out.size() < length; i++) {
            block = hmac(prk, block, info, new byte[] { (byte) i });
            out.writeBytes(block);
        }
        return Arrays.copyOf(out.toByteArray(), length);
    }

    static byte[] seal(byte[] key, byte[] nonce, byte[] aad, byte[] plaintext) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
        cipher.updateAAD(aad);
        return cipher.doFinal(plaintext);
    }

    static byte[] open(byte[] key, byte[] nonce, byte[] aad, byte[] sealed) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
        cipher.updateAAD(aad);
        return cipher.doFinal(sealed);
    }

    static byte[] sha256(byte[]... parts) throws GeneralSecurityException {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        for (byte[] part : parts)
            digest.update(part);
        return digest.digest();
    }

    static String serviceId(byte[] secret) throws GeneralSecurityException {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(Arrays.copyOf(sha256(SERVICE_ID_LABEL, secret), 12));
    }

    // --- Point arithmetic, only to check the vector's public keys -----------------------------

    static BigInteger[] add(BigInteger[] p, BigInteger[] q) {
        if (p == null) return q;
        if (q == null) return p;
        BigInteger slope;
        if (p[0].equals(q[0])) {
            if (!p[1].equals(q[1]) || p[1].signum() == 0) return null;
            slope = p[0].pow(2).multiply(BigInteger.valueOf(3)).add(A).multiply(p[1].shiftLeft(1).modInverse(P)).mod(P);
        } else {
            slope = q[1].subtract(p[1]).multiply(q[0].subtract(p[0]).modInverse(P)).mod(P);
        }
        BigInteger x = slope.pow(2).subtract(p[0]).subtract(q[0]).mod(P);
        return new BigInteger[] { x, slope.multiply(p[0].subtract(x)).subtract(p[1]).mod(P) };
    }

    static BigInteger[] multiply(BigInteger k, BigInteger[] point) {
        BigInteger[] result = null;
        for (int i = k.bitLength() - 1; i >= 0; i--) {
            result = add(result, result);
            if (k.testBit(i)) result = add(result, point);
        }
        return result;
    }

    static byte[] encodePoint(BigInteger[] point) {
        return concat(new byte[] { 0x04 }, fixed32(point[0]), fixed32(point[1]));
    }

    static byte[] fixed32(BigInteger n) {
        byte[] raw = n.toByteArray();
        byte[] out = new byte[32];
        int copy = Math.min(raw.length, 32);
        System.arraycopy(raw, raw.length - copy, out, 32 - copy, copy);
        return out;
    }

    // --- Encoding helpers ---------------------------------------------------------------------

    static byte[] utf8(String s) { return s.getBytes(StandardCharsets.UTF_8); }
    static byte[] hex(String s) { return HexFormat.of().parseHex(s); }
    static byte[] b64u(String s) { return Base64.getUrlDecoder().decode(s); }

    static byte[] base32(String s) {
        String alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int bits = 0, value = 0;
        for (char c : s.toCharArray()) {
            value = (value << 5) | alphabet.indexOf(c);
            bits += 5;
            if (bits >= 8) {
                out.write((value >>> (bits - 8)) & 0xff);
                bits -= 8;
            }
        }
        return out.toByteArray();
    }

    static byte[] lp(byte[] b) {
        return concat(new byte[] { (byte) (b.length >>> 8), (byte) b.length }, b);
    }

    static byte[] concat(byte[]... parts) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] part : parts)
            out.writeBytes(part);
        return out.toByteArray();
    }

    static void check(boolean ok, String what) {
        checks++;
        if (!ok) throw new AssertionError("FAILED: " + what);
    }

    static void same(byte[] actual, byte[] expected, String what) {
        check(Arrays.equals(actual, expected), what + "\n  expected " + HexFormat.of().formatHex(expected)
                + "\n  got      " + HexFormat.of().formatHex(actual));
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> map(Object o) { return (Map<String, Object>) o; }
    @SuppressWarnings("unchecked")
    static List<Object> list(Object o) { return (List<Object>) o; }
    static String str(Map<String, Object> m, String key) { return (String) m.get(key); }

    /** Just enough JSON for the vectors file: objects, arrays, strings, integers, booleans, null. */
    static final class Json {
        private final String s;
        private int i;

        private Json(String s) { this.s = s; }

        static Object parse(String s) {
            Json json = new Json(s);
            Object value = json.value();
            json.skipSpace();
            if (json.i != s.length()) throw new IllegalArgumentException("trailing characters");
            return value;
        }

        private void skipSpace() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        }

        private Object value() {
            skipSpace();
            char c = s.charAt(i);
            if (c == '{') return object();
            if (c == '[') return array();
            if (c == '"') return string();
            if (s.startsWith("true", i)) { i += 4; return true; }
            if (s.startsWith("false", i)) { i += 5; return false; }
            if (s.startsWith("null", i)) { i += 4; return null; }
            int start = i;
            while (i < s.length() && "-0123456789".indexOf(s.charAt(i)) >= 0) i++;
            return Long.parseLong(s.substring(start, i));
        }

        private Map<String, Object> object() {
            Map<String, Object> map = new LinkedHashMap<>();
            i++;
            skipSpace();
            if (s.charAt(i) == '}') { i++; return map; }
            while (true) {
                skipSpace();
                String key = string();
                skipSpace();
                i++; // ':'
                map.put(key, value());
                skipSpace();
                if (s.charAt(i++) == '}') return map;
            }
        }

        private List<Object> array() {
            List<Object> list = new ArrayList<>();
            i++;
            skipSpace();
            if (s.charAt(i) == ']') { i++; return list; }
            while (true) {
                list.add(value());
                skipSpace();
                if (s.charAt(i++) == ']') return list;
            }
        }

        private String string() {
            StringBuilder out = new StringBuilder();
            i++;
            while (true) {
                char c = s.charAt(i++);
                if (c == '"') return out.toString();
                if (c != '\\') { out.append(c); continue; }
                char e = s.charAt(i++);
                switch (e) {
                    case 'n' -> out.append('\n');
                    case 't' -> out.append('\t');
                    case 'r' -> out.append('\r');
                    case 'b' -> out.append('\b');
                    case 'f' -> out.append('\f');
                    case 'u' -> { out.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; }
                    default -> out.append(e);
                }
            }
        }
    }
}
