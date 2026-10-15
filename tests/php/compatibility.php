<?php
// Run after composer install. Optional source directory permits testing the original snapshot.
$root = dirname(__DIR__, 2);
$source = getenv('THINKAI_SDK_SOURCE') ?: $root . '/php/src';
require getenv('THINKAI_VENDOR_AUTOLOAD') ?: $root . '/vendor/autoload.php';
spl_autoload_register(function ($class) use ($source) {
    if (str_starts_with($class, 'think\\ai\\')) {
        $path = $source . '/' . str_replace('\\', '/', substr($class, 9)) . '.php';
        if (is_file($path)) require $path;
    }
}, true, true);

use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Response;
use Psr\Http\Message\StreamInterface;
use think\ai\Client;
use think\ai\StreamIterator;

$assertions = 0;
function check($condition, $message) {
    global $assertions;
    ++$assertions;
    if (!$condition) throw new RuntimeException($message);
}
function fixtureClient($responses, &$history) {
    $history = [];
    $mock = new MockHandler($responses);
    $stack = HandlerStack::create($mock);
    $stack->push(Middleware::history($history));
    return (new Client('offline-token', $stack))->setEndpoint('https://offline.invalid/');
}

$operations = json_decode(file_get_contents($root . '/tests/contracts/operations.json'), true, 512, JSON_THROW_ON_ERROR);
check(count($operations) === 37, 'Expected PHP 37-method baseline');
$payload = ['model' => 'offline-model', 'input' => '你好', 'stream' => false, 'extra' => ['flag' => false, 'null' => null]];
$upload = fopen('php://temp', 'r+');
fwrite($upload, 'fixture-upload');
rewind($upload);
foreach ($operations as $operation) {
    $resource = $operation['resource'];
    $method = $operation['operation'];
    $args = [$payload];
    $expectedBody = $payload;
    $expectedQuery = [];
    $path = str_replace(['{type}', '{code}', '{id}'], ['chat', 'offline-model', 'offline-id'], $operation['path']);
    if ($operation['http_method'] === 'GET') { $expectedQuery = $payload; $expectedBody = null; }
    if ($resource === 'model' && $method === 'show') { $args = ['chat', 'offline-model']; $expectedQuery = []; }
    if ($resource === 'skill' && $method === 'categories') { $args = []; $expectedQuery = []; }
    if ($resource === 'skill' && $method === 'download') { $args = ['folder/技能.zip']; $expectedQuery = ['path' => $args[0]]; }
    if ($resource === 'sandbox') {
        $expectedQuery = [];
        switch ($method) {
            case 'create': $args = ['fixture']; $expectedBody = ['name' => 'fixture']; break;
            case 'get': case 'delete': $args = ['offline-id']; $expectedBody = null; break;
            case 'listFile': case 'readFile': case 'downloadFile':
                $args = ['offline-id', 'folder/a.txt']; $expectedBody = null; $expectedQuery = ['path' => $args[1]]; break;
            case 'writeFile': $args = ['offline-id', 'a.txt', '你好']; $expectedBody = ['path' => 'a.txt', 'content' => '你好']; break;
            case 'editFile': $args = ['offline-id', 'a.txt', 'old', 'new']; $expectedBody = ['path' => 'a.txt', 'old_str' => 'old', 'new_str' => 'new']; break;
            case 'uploadFile': $args = ['offline-id', 'a.txt', $upload]; $expectedBody = null; break;
            case 'runCode': $args = ['offline-id', 'print(1)', []]; $expectedBody = ['code' => 'print(1)', 'files' => []]; break;
            case 'runCommand': $args = ['offline-id', 'echo fixture', false]; $expectedBody = ['command' => 'echo fixture', 'stream' => false]; break;
        }
    }
    $response = $operation['response'] === 'binary'
        ? new Response(200, ['Content-Type' => 'application/octet-stream'], "\0\1\xff")
        : new Response(200, ['Content-Type' => 'application/json'], '{"ok":true,"extra":null}');
    $client = fixtureClient([$response], $history);
    $result = $client->$resource()->$method(...$args);
    check(count($history) === 1, "$resource.$method request count");
    $request = $history[0]['request'];
    check($request->getMethod() === $operation['http_method'], "$resource.$method HTTP method");
    check($request->getUri()->getPath() === '/' . $path, "$resource.$method path");
    check($request->getHeaderLine('Authorization') === 'Bearer offline-token', "$resource.$method authentication");
    parse_str($request->getUri()->getQuery(), $actualQuery);
    // URL encoding makes scalar query values strings, like the pre-migration Guzzle client.
    $queryString = http_build_query($expectedQuery, '', '&', PHP_QUERY_RFC3986);
    parse_str($queryString, $encodedQuery);
    check($actualQuery === $encodedQuery, "$resource.$method query");
    if ($resource === 'sandbox' && $method === 'uploadFile') {
        $wire = (string) $request->getBody();
        check(str_contains($request->getHeaderLine('Content-Type'), 'multipart/form-data'), 'Multipart type');
        check(str_contains($wire, 'name="path"') && str_contains($wire, 'name="file"') && str_contains($wire, 'fixture-upload'), 'Multipart fields and bytes');
    } elseif ($expectedBody !== null) {
        check(json_decode((string) $request->getBody(), true) === $expectedBody, "$resource.$method JSON request");
    } else {
        check((string) $request->getBody() === '', "$resource.$method empty request");
    }
    if ($resource === 'sandbox' && $method === 'delete') check($result === null, 'PHP delete remains void');
    elseif ($operation['response'] === 'binary') check($result instanceof StreamInterface && (string) $result === "\0\1\xff", 'PHP binary stream');
    else check($result === ['ok' => true, 'extra' => null], "$resource.$method raw JSON result");
}
fclose($upload);

foreach ([['chat', 'completions', ['model' => 'offline']], ['responses', 'create', ['model' => 'offline', 'input' => 'hello']], ['sandbox', 'runCommand', null]] as [$resource, $method, $params]) {
    $client = fixtureClient([new Response(200, ['Content-Type' => 'text/event-stream'], "data: {\"value\":\"你好\"}\n\ndata: {\"value\":2}\n\ndata: [DONE]\n\n")], $history);
    $args = $params === null ? ['offline-id', 'echo fixture', true] : [$params];
    $result = $client->$resource()->$method(...$args);
    check($result instanceof StreamIterator, "$resource iterator compatibility");
    check(iterator_to_array($result, false) === [['value' => '你好'], ['value' => 2]], "$resource SSE compatibility");
    check($history[0]['options']['stream'] === true, "$resource stream transport option");
}
$client = fixtureClient([new Response(200, ['Content-Type' => 'text/event-stream'], "data: {\"audio\":{}}\n\n")], $history);
check($client->audio()->speech(['stream' => true]) instanceof StreamInterface, 'PHP existing raw audio SSE return is preserved');
$client = fixtureClient([new Response(204)], $history);
check($client->sandbox()->writeFile('offline-id', 'a.txt', '') instanceof StreamInterface, 'PHP existing empty response stream is preserved');
$client = fixtureClient([new Response(400, ['Content-Type' => 'application/json'], '{"message":"fixture error"}')], $history);
try { $client->decision()->evaluate([]); check(false, 'Expected original Guzzle error'); }
catch (GuzzleHttp\Exception\ClientException $error) { check($error->getResponse()->getStatusCode() === 400, 'PHP existing HTTP exception behavior'); }
$client = fixtureClient([new Response(200, ['Content-Type' => 'application/json'], '{"id":"original-task"}'), new Response(200, ['Content-Type' => 'application/json'], '{"status":"success"}')], $history);
check($client->avatar()->video(['model' => 'offline'], true) === ['status' => 'success'], 'Avatar wait result');
check(json_decode((string) $history[1]['request']->getBody(), true) === ['model' => 'offline', 'id' => 'original-task'], 'Avatar polls original task');
echo json_encode(['operations' => count($operations), 'assertions' => $assertions, 'source' => $source], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . PHP_EOL;
