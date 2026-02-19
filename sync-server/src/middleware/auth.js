/**
 * Simple API key authentication middleware.
 * Checks for the key in the X-API-Key header or Authorization: Bearer <key>.
 */
export function authMiddleware(apiKey) {
    return (req, res, next) => {
        const headerKey = req.headers['x-api-key'];
        const authHeader = req.headers['authorization'];
        let bearerKey = null;

        if (authHeader && authHeader.startsWith('Bearer ')) {
            bearerKey = authHeader.slice(7);
        }

        if (headerKey === apiKey || bearerKey === apiKey) {
            next();
        } else {
            res.status(401).json({ error: 'Unauthorized - invalid or missing API key' });
        }
    };
}
