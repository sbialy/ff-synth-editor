// Minimal JSON reader and writer for the host protocol (one JSON object per line). No dependencies.
// Numbers are doubles, floats are written with %.9g so a float survives the text round trip exactly.
#pragma once

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace pj
{

struct Json
{
    enum class Type { kNull, kBool, kNum, kStr, kArr, kObj };
    Type type = Type::kNull;
    bool b = false;
    double n = 0;
    std::string s;
    std::vector<Json> a;
    std::vector<std::pair<std::string, Json>> o;

    bool isNull() const { return type == Type::kNull; }
    bool isNum() const { return type == Type::kNum; }
    bool isStr() const { return type == Type::kStr; }
    bool isArr() const { return type == Type::kArr; }
    bool isObj() const { return type == Type::kObj; }

    const Json* get(const char* key) const
    {
        if (type != Type::kObj)
        {
            return nullptr;
        }
        for (const auto& kv : o)
        {
            if (kv.first == key)
            {
                return &kv.second;
            }
        }
        return nullptr;
    }
    std::string str(const char* key, const std::string& def = {}) const
    {
        const Json* v = get(key);
        return v && v->type == Type::kStr ? v->s : def;
    }
    double num(const char* key, double def) const
    {
        const Json* v = get(key);
        return v && v->type == Type::kNum ? v->n : def;
    }
    bool flag(const char* key, bool def) const
    {
        const Json* v = get(key);
        return v && v->type == Type::kBool ? v->b : def;
    }
};

class Parser
{
  public:
    static Json parse(const std::string& text)
    {
        Parser p{ text };
        Json v = p.value();
        p.ws();
        if (p.i != text.size())
        {
            p.fail("trailing characters");
        }
        return v;
    }

  private:
    explicit Parser(const std::string& t)
      : t(t)
    {
    }
    const std::string& t;
    size_t i = 0;

    [[noreturn]] void fail(const char* what) const
    {
        throw std::runtime_error(std::string("json: ") + what + " at offset " + std::to_string(i));
    }
    void ws()
    {
        while (i < t.size() && (t[i] == ' ' || t[i] == '\t' || t[i] == '\n' || t[i] == '\r'))
        {
            i++;
        }
    }
    bool lit(const char* w)
    {
        size_t n = 0;
        while (w[n])
        {
            n++;
        }
        if (t.compare(i, n, w) == 0)
        {
            i += n;
            return true;
        }
        return false;
    }
    Json value()
    {
        ws();
        if (i >= t.size())
        {
            fail("unexpected end");
        }
        Json v;
        const char c = t[i];
        if (c == '{')
        {
            i++;
            v.type = Json::Type::kObj;
            ws();
            if (i < t.size() && t[i] == '}')
            {
                i++;
                return v;
            }
            for (;;)
            {
                ws();
                if (i >= t.size() || t[i] != '"')
                {
                    fail("object key expected");
                }
                std::string k = string();
                ws();
                if (i >= t.size() || t[i] != ':')
                {
                    fail("':' expected");
                }
                i++;
                v.o.emplace_back(std::move(k), value());
                ws();
                if (i < t.size() && t[i] == ',')
                {
                    i++;
                    continue;
                }
                if (i < t.size() && t[i] == '}')
                {
                    i++;
                    return v;
                }
                fail("',' or '}' expected");
            }
        }
        if (c == '[')
        {
            i++;
            v.type = Json::Type::kArr;
            ws();
            if (i < t.size() && t[i] == ']')
            {
                i++;
                return v;
            }
            for (;;)
            {
                v.a.push_back(value());
                ws();
                if (i < t.size() && t[i] == ',')
                {
                    i++;
                    continue;
                }
                if (i < t.size() && t[i] == ']')
                {
                    i++;
                    return v;
                }
                fail("',' or ']' expected");
            }
        }
        if (c == '"')
        {
            v.type = Json::Type::kStr;
            v.s = string();
            return v;
        }
        if (lit("true"))
        {
            v.type = Json::Type::kBool;
            v.b = true;
            return v;
        }
        if (lit("false"))
        {
            v.type = Json::Type::kBool;
            return v;
        }
        if (lit("null"))
        {
            return v;
        }
        char* end = nullptr;
        const double d = std::strtod(t.c_str() + i, &end);
        if (end == t.c_str() + i)
        {
            fail("value expected");
        }
        i = size_t(end - t.c_str());
        v.type = Json::Type::kNum;
        v.n = d;
        return v;
    }
    static void utf8(std::string& out, unsigned cp)
    {
        if (cp < 0x80)
        {
            out += char(cp);
        }
        else if (cp < 0x800)
        {
            out += char(0xC0 | (cp >> 6));
            out += char(0x80 | (cp & 0x3F));
        }
        else if (cp < 0x10000)
        {
            out += char(0xE0 | (cp >> 12));
            out += char(0x80 | ((cp >> 6) & 0x3F));
            out += char(0x80 | (cp & 0x3F));
        }
        else
        {
            out += char(0xF0 | (cp >> 18));
            out += char(0x80 | ((cp >> 12) & 0x3F));
            out += char(0x80 | ((cp >> 6) & 0x3F));
            out += char(0x80 | (cp & 0x3F));
        }
    }
    unsigned hex4()
    {
        if (i + 4 > t.size())
        {
            fail("bad \\u escape");
        }
        unsigned v = 0;
        for (int k = 0; k < 4; k++)
        {
            const char h = t[i++];
            v <<= 4;
            if (h >= '0' && h <= '9') v |= unsigned(h - '0');
            else if (h >= 'a' && h <= 'f') v |= unsigned(h - 'a' + 10);
            else if (h >= 'A' && h <= 'F') v |= unsigned(h - 'A' + 10);
            else fail("bad \\u escape");
        }
        return v;
    }
    std::string string()
    {
        i++; // opening quote
        std::string out;
        for (;;)
        {
            if (i >= t.size())
            {
                fail("unterminated string");
            }
            const char c = t[i++];
            if (c == '"')
            {
                return out;
            }
            if (c != '\\')
            {
                out += c;
                continue;
            }
            if (i >= t.size())
            {
                fail("bad escape");
            }
            const char e = t[i++];
            switch (e)
            {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'u':
                {
                    unsigned cp = hex4();
                    if (cp >= 0xD800 && cp < 0xDC00 && t.compare(i, 2, "\\u") == 0)
                    {
                        i += 2;
                        const unsigned lo = hex4();
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    }
                    utf8(out, cp);
                    break;
                }
                default: fail("bad escape");
            }
        }
    }
};

// ---- writer: builds text directly

inline void putStr(std::string& out, const std::string& s)
{
    out += '"';
    for (unsigned char c : s)
    {
        switch (c)
        {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20)
                {
                    char b[8];
                    snprintf(b, sizeof(b), "\\u%04x", c);
                    out += b;
                }
                else
                {
                    out += char(c);
                }
        }
    }
    out += '"';
}

inline void putNum(std::string& out, double v)
{
    if (!std::isfinite(v))
    {
        out += "null";
        return;
    }
    char b[40];
    snprintf(b, sizeof(b), "%.9g", v);
    out += b;
}

// Float written so that strtof gives the identical float back
inline void putFloat(std::string& out, float v)
{
    if (!std::isfinite(v))
    {
        out += "null";
        return;
    }
    char b[40];
    snprintf(b, sizeof(b), "%.9g", double(v));
    out += b;
}

// Tiny object/array builders that own their text: finish with done()
class Obj
{
  public:
    Obj& key(const char* k)
    {
        if (n++)
        {
            out += ',';
        }
        putStr(out, k);
        out += ':';
        return *this;
    }
    Obj& str(const char* k, const std::string& v) { key(k); putStr(out, v); return *this; }
    Obj& num(const char* k, double v) { key(k); putNum(out, v); return *this; }
    Obj& flt(const char* k, float v) { key(k); putFloat(out, v); return *this; }
    Obj& boolean(const char* k, bool v) { key(k); out += v ? "true" : "false"; return *this; }
    Obj& raw(const char* k, const std::string& json) { key(k); out += json; return *this; }
    std::string done() const { return out + "}"; }

  private:
    std::string out = "{";
    int n = 0;
};

class Arr
{
  public:
    Arr& str(const std::string& v) { sep(); putStr(out, v); return *this; }
    Arr& num(double v) { sep(); putNum(out, v); return *this; }
    Arr& flt(float v) { sep(); putFloat(out, v); return *this; }
    Arr& raw(const std::string& json) { sep(); out += json; return *this; }
    std::string done() const { return out + "]"; }

  private:
    void sep()
    {
        if (n++)
        {
            out += ',';
        }
    }
    std::string out = "[";
    int n = 0;
};

} // namespace pj
